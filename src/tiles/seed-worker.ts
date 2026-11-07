import { parentPort, workerData } from "node:worker_threads";
import type { ServerAPI } from "@signalk/server-api";
import type {
  HistoryApi,
  PathSpec,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import type { Config } from "../config.js";
import {
  TideDatum,
  createSlackwaterTideProvider,
  createTideCorrection,
} from "../tide.js";
import type { TransducerOffset } from "./core/index.js";
import { seedFromHistory, SeedProgress } from "./seed.js";
import { createTileDB, createTileStore } from "./store.js";

/** Everything the seed worker needs to rebuild the store on its own. */
export interface SeedWorkerData {
  dbPath: string;
  config: Config;
  resolution?: number;
  offset?: TransducerOffset;
  /** The datum to fold history into, or undefined when correction is off. */
  tide?: TideDatum;
}

/** A history request with the instants flattened to strings: Temporal objects
 * do not survive `postMessage` structured cloning. */
export interface SeedWorkerValuesRequest {
  from: string;
  to: string;
  resolution?: number;
  pathSpecs: PathSpec[];
}

/** Messages the worker sends to the plugin. */
export type SeedWorkerOut =
  | { type: "progress"; progress: SeedProgress }
  | { type: "result"; progress: SeedProgress }
  | { type: "error"; message: string }
  | { type: "debug"; message: string }
  | { type: "getValues"; id: number; req: SeedWorkerValuesRequest };

/** Messages the plugin sends back to the worker. */
export type SeedWorkerIn =
  | { type: "getValuesResult"; id: number; res: ValuesResponse }
  | { type: "getValuesError"; id: number; message: string }
  | { type: "abort" };

/** The slice of a worker's `parentPort` the seed needs, so tests can drive it
 * without a real thread. */
export interface SeedWorkerPort {
  post(message: SeedWorkerOut): void;
  onMessage(handler: (message: SeedWorkerIn) => void): void;
}

/**
 * Rebuild the tile store in a worker thread.
 *
 * The History API provider lives in the main process, so the worker asks the
 * plugin for each chunk over the port instead of reaching for the provider
 * directly. Everything expensive — folding rows, the tide lookup arithmetic,
 * the SQLite writes and the pyramid rebuild — happens here, off the event loop.
 */
export async function runSeedWorker(
  data: SeedWorkerData,
  port: SeedWorkerPort,
): Promise<void> {
  const pending = new Map<
    number,
    { resolve: (res: ValuesResponse) => void; reject: (err: Error) => void }
  >();
  let nextId = 1;
  const controller = new AbortController();

  const abort = () => {
    controller.abort();
    for (const request of pending.values()) {
      request.reject(new Error("aborted"));
    }
    pending.clear();
  };

  port.onMessage((message) => {
    if (message.type === "abort") {
      abort();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "getValuesResult") {
      request.resolve(message.res);
    } else {
      request.reject(new Error(message.message));
    }
  });

  const history: HistoryApi = {
    getValues(req: ValuesRequest) {
      if (!req.from || !req.to) {
        return Promise.reject(new Error("history request needs from and to"));
      }
      return new Promise<ValuesResponse>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        port.post({
          type: "getValues",
          id,
          req: {
            from: req.from.toString(),
            to: req.to.toString(),
            resolution: req.resolution,
            pathSpecs: req.pathSpecs,
          },
        });
      });
    },
    getContexts: async () => [],
    getPaths: async () => [],
  };

  let store: ReturnType<typeof createTileStore> | undefined;
  try {
    store = createTileStore(createTileDB(data.dbPath));
    const tide = data.tide
      ? createTideCorrection(await createSlackwaterTideProvider(), data.tide)
      : undefined;
    const app = {
      debug: (format: string, ...args: unknown[]) =>
        port.post({
          type: "debug",
          message: `${format} ${args.map(String).join(" ")}`,
        }),
    } as unknown as ServerAPI;

    const progress = await seedFromHistory({
      app,
      store,
      config: data.config,
      resolution: data.resolution,
      offset: data.offset,
      tide,
      history,
      signal: controller.signal,
      onProgress: (p) => port.post({ type: "progress", progress: p }),
    });
    port.post({ type: "result", progress });
  } catch (err) {
    port.post({ type: "error", message: String(err) });
  } finally {
    store?.close();
  }
}

const mainThread = parentPort;
if (mainThread) {
  const port: SeedWorkerPort = {
    post: (message) => mainThread.postMessage(message),
    onMessage: (handler) =>
      mainThread.on("message", (message) => handler(message as SeedWorkerIn)),
  };
  void runSeedWorker(workerData as SeedWorkerData, port).finally(() => {
    // The message listener itself keeps the thread alive. Close the port a
    // turn later so the final `result` message is delivered before it exits.
    setImmediate(() => mainThread.close());
  });
}
