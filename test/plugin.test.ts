import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import type {
  HistoryApi,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import createPlugin, {
  readLengthOverall,
  resolveTransducerOffset,
} from "../src/plugin.js";
import type { Config } from "../src/config.js";
import { createTileDB, createTileStore } from "../src/tiles/store.js";
import { SEED_CURSOR_KEY } from "../src/tiles/seed.js";
import { runSeedWorker } from "../src/tiles/seed-worker.js";
import type {
  SeedWorkerData,
  SeedWorkerIn,
  SeedWorkerOut,
  SeedWorkerPort,
} from "../src/tiles/seed-worker.js";

function appReturning(node: unknown): ServerAPI {
  return { getSelfPath: () => node } as unknown as ServerAPI;
}

test("reads length overall from the compound design.length node", () => {
  // The server exposes design.length as { value: { overall, hull, waterline } };
  // there is no `design.length.overall` leaf for getSelfPath to resolve.
  expect(readLengthOverall(appReturning({ value: { overall: 13.97 } }))).toBe(
    13.97,
  );
});

test("accepts a bare number or a numeric value node", () => {
  expect(readLengthOverall(appReturning(13.97))).toBe(13.97);
  expect(readLengthOverall(appReturning({ value: 13.97 }))).toBe(13.97);
});

test("undefined when the length is absent or non-positive", () => {
  expect(readLengthOverall(appReturning(undefined))).toBeUndefined();
  expect(
    readLengthOverall(appReturning({ value: { overall: 0 } })),
  ).toBeUndefined();
  expect(
    readLengthOverall(appReturning({ value: { overall: -3 } })),
  ).toBeUndefined();
});

function correctionApp(
  lengthOverall: number | undefined,
  gnssCorrection = "replace",
): ServerAPI {
  return {
    getSelfPath: () =>
      lengthOverall === undefined
        ? undefined
        : { value: { overall: lengthOverall } },
    config: { settings: { gnssCorrection } },
    setPluginError: () => {},
  } as unknown as ServerAPI;
}

const correctionConfig: Config = {
  path: "belowSurface",
  sounder: { x: -1.7, y: 4.16 },
  transducerCorrection: "replace",
};

// Regression: the offset is from the reference (midships) TO the transducer, so
// a transducer forward of midships is a positive shift toward the bow. The sign
// was once inverted, which drew every sounding behind the vessel.
test("a transducer forward of midships is placed ahead of the reference", () => {
  const offset = resolveTransducerOffset(
    correctionApp(13.97),
    correctionConfig,
  );
  // midships is 13.97 / 2 = 6.985 m from the bow, so the transducer at 4.16 m
  // from the bow is 2.825 m forward of it, and 1.7 m to port.
  expect(offset?.forward).toBeCloseTo(2.825, 6);
  expect(offset?.starboard).toBe(-1.7);
});

test("a transducer aft of midships is placed astern of the reference", () => {
  const offset = resolveTransducerOffset(correctionApp(13.97), {
    ...correctionConfig,
    sounder: { x: 0, y: 9 },
  });
  expect(offset?.forward).toBeCloseTo(6.985 - 9, 6);
});

test("no offset when the correction is off or the length is unknown", () => {
  expect(
    resolveTransducerOffset(correctionApp(13.97), {
      ...correctionConfig,
      transducerCorrection: "off",
    }),
  ).toBeUndefined();
  expect(
    resolveTransducerOffset(correctionApp(undefined), correctionConfig),
  ).toBeUndefined();
});

/** A server stub with only the API the plugin touches at start. */
function seedApp(dir: string, history: HistoryApi): ServerAPI {
  return {
    getDataDirPath: () => dir,
    debug: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getSelfPath: () => undefined,
    getPath: () => undefined,
    getHistoryApi: async () => history,
    subscriptionmanager: { subscribe: () => {} },
    error: () => {},
    config: { settings: {} },
  } as unknown as ServerAPI;
}

/** A worker-shaped object that runs the real seed worker on this thread with a
 * loopback port, so the plugin's RPC wiring is exercised without a thread. */
class FakeSeedWorker {
  private mainMessage?: (message: SeedWorkerOut) => void;
  private mainExit?: (code: number) => void;
  private workerMessage?: (message: SeedWorkerIn) => void;
  private terminated = false;
  private readonly port: SeedWorkerPort;

  constructor(private readonly data: SeedWorkerData) {
    this.port = {
      post: (message) => this.mainMessage?.(message),
      onMessage: (handler) => {
        this.workerMessage = handler;
      },
    };
    queueMicrotask(() => {
      if (this.terminated) {
        this.mainExit?.(0);
        return;
      }
      void runSeedWorker(this.data, this.port).then(() => this.mainExit?.(0));
    });
  }

  on(event: string, handler: (value: never) => void) {
    if (event === "message") {
      this.mainMessage = handler as (message: SeedWorkerOut) => void;
    } else if (event === "exit") {
      this.mainExit = handler as (code: number) => void;
    }
    return this;
  }

  postMessage(message: SeedWorkerIn) {
    this.workerMessage?.(message);
  }

  terminate() {
    this.terminated = true;
    this.workerMessage?.({ type: "abort" });
    return Promise.resolve(0);
  }
}

test("an interrupted seed keeps its trigger and resumes from the cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "livedepth-seed-"));
  try {
    const cursor = Temporal.Now.instant().subtract({ hours: 24 });
    const db = createTileStore(
      createTileDB(join(dir, "bathymetry-tiles.sqlite")),
    );
    db.setMeta(SEED_CURSOR_KEY, cursor.toString());
    db.close();

    const requests: ValuesRequest[] = [];
    let blockSecond = true;
    let release: (() => void) | undefined;
    let markSecond = () => {};
    const secondRequest = new Promise<void>((resolve) => {
      markSecond = resolve;
    });

    const history = {
      getValues: vi.fn(async (req: ValuesRequest): Promise<ValuesResponse> => {
        requests.push(req);
        if (blockSecond && requests.length === 2) {
          // Hold the second chunk open so the test can stop the plugin
          // mid-run, exactly as a restart would.
          const blocked = new Promise<void>((resolve) => {
            release = resolve;
          });
          markSecond();
          await blocked;
        }
        return { values: [], data: [] } as unknown as ValuesResponse;
      }),
      getContexts: vi.fn(async () => ({})),
      getPaths: vi.fn(async () => ({})),
    } as unknown as HistoryApi;

    const app = seedApp(dir, history);
    const config: Config = {
      path: "belowSurface",
      sounder: { x: 0, y: 0 },
      transducerCorrection: "off",
      seed: { run: true, resolution: 1 },
    };

    const running = createPlugin(app, {
      createSeedWorker: (data) => new FakeSeedWorker(data) as unknown as Worker,
    });
    const restart = vi.fn();

    await running.start(config, restart);
    await secondRequest;

    // Stopping closes the store, so the in-flight chunk cannot advance the
    // cursor; the last completed chunk is where the next run must resume.
    running.stop();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(restart).not.toHaveBeenCalled();
    const resumedAt = requests[1]!.from;

    // Start again with the trigger still set: it resumes at the cursor and
    // clears the trigger only after finishing.
    blockSecond = false;
    requests.length = 0;
    await running.start(config, restart);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));

    expect(requests[0]!.from.toString()).toBe(resumedAt.toString());
    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: expect.objectContaining({ run: false }),
      }),
    );
    running.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
