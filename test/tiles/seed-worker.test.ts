import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import type { ValuesResponse } from "@signalk/server-api/history";
import type { Config } from "../../src/config.js";
import { BASE_ZOOM } from "../../src/tiles/core/index.js";
import { SEED_CURSOR_KEY } from "../../src/tiles/seed.js";
import {
  runSeedWorker,
  type SeedWorkerIn,
  type SeedWorkerOut,
  type SeedWorkerPort,
} from "../../src/tiles/seed-worker.js";
import { createTileDB, createTileStore } from "../../src/tiles/store.js";

const config = {
  path: "belowTransducer",
  sounder: { x: 0, y: 0 },
  transducerCorrection: "off",
} as Config;

const depthPath = `environment.depth.${config.path}`;

function values(from: string, to: string): ValuesResponse {
  return {
    context: "vessels.self",
    range: { from, to },
    values: [{ path: "navigation.position" }, { path: depthPath }],
    data: [
      [from, [0.001, 0.001], 12],
      [to, [0.002, 0.002], 9],
    ],
  } as unknown as ValuesResponse;
}

function temporaryStore(cursor: Temporal.Instant): {
  dir: string;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "livedepth-seed-worker-"));
  const dbPath = join(dir, "bathymetry-tiles.sqlite");
  const store = createTileStore(createTileDB(dbPath));
  store.setMeta(SEED_CURSOR_KEY, cursor.toString());
  store.close();
  return { dir, dbPath };
}

test("folds a chunk off the main thread and reports the result", async () => {
  const cursor = Temporal.Now.instant().subtract({ hours: 6 });
  const { dir, dbPath } = temporaryStore(cursor);
  const messages: SeedWorkerOut[] = [];
  let handler: ((message: SeedWorkerIn) => void) | undefined;
  const port: SeedWorkerPort = {
    post: (message) => {
      messages.push(message);
      if (message.type === "getValues") {
        const res = values(message.req.from, message.req.to);
        queueMicrotask(() =>
          handler?.({ type: "getValuesResult", id: message.id, res }),
        );
      }
    },
    onMessage: (fn) => {
      handler = fn;
    },
  };

  try {
    await runSeedWorker({ dbPath, config, resolution: 1 }, port);

    const result = messages.find((m) => m.type === "result");
    expect(result).toBeDefined();
    if (result?.type !== "result") throw new Error("worker did not report");
    expect(result.progress.done).toBe(true);
    expect(result.progress.points).toBeGreaterThan(0);

    const store = createTileStore(createTileDB(dbPath));
    expect(store.getMeta(SEED_CURSOR_KEY)).not.toBe(cursor.toString());
    expect(store.listTiles(BASE_ZOOM)).not.toHaveLength(0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an abort stops without advancing the cursor", async () => {
  const cursor = Temporal.Now.instant().subtract({ hours: 6 });
  const { dir, dbPath } = temporaryStore(cursor);
  const messages: SeedWorkerOut[] = [];
  let handler: ((message: SeedWorkerIn) => void) | undefined;
  const port: SeedWorkerPort = {
    post: (message) => {
      messages.push(message);
      // Leave getValues unanswered: the abort must reject it.
    },
    onMessage: (fn) => {
      handler = fn;
    },
  };

  try {
    const run = runSeedWorker({ dbPath, config, resolution: 1 }, port);
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === "getValues")).toBe(true),
    );
    handler?.({ type: "abort" });
    await run;

    const result = messages.find((m) => m.type === "result");
    if (result?.type !== "result") throw new Error("worker did not report");
    expect(result.progress.done).toBe(false);

    const store = createTileStore(createTileDB(dbPath));
    expect(store.getMeta(SEED_CURSOR_KEY)).toBe(cursor.toString());
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
