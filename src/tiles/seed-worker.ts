import { parentPort, workerData } from "node:worker_threads";
import type { Context, Path, ServerAPI } from "@signalk/server-api";
import type {
  ContextsRequest,
  ContextsResponse,
  HistoryApi,
  PathSpec,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import type { Config } from "../config.js";
import { BATHY_EPOCH } from "../constants.js";
import {
  TideDatum,
  createSlackwaterTideProvider,
  createTideCorrection,
} from "../tide.js";
import { rebuildAncestors, type TransducerOffset } from "./core/index.js";
import { seedFromHistory, SeedProgress } from "./seed.js";
import { createTileDB, createTileStore } from "./store.js";

/** Historical context probes use a daily bucket: large enough to bound a
 * multi-year response, small enough to find a short-lived vessel. */
const DISCOVERY_RESOLUTION_S = 86_400;
/** Concurrent provider probes. The provider is in the main process; a handful
 * at a time discovers contexts without flooding it. */
const DISCOVERY_CONCURRENCY = 4;
/** A single unresponsive provider query must not stop the discovery pass. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/** Everything the seed worker needs to rebuild the store on its own. */
export interface SeedWorkerData {
  dbPath: string;
  config: Config;
  resolution?: number;
  offset?: TransducerOffset;
  /** The datum to fold history into, or undefined when correction is off. */
  tide?: TideDatum;
  /** The vessel's own context, for applying its known transducer offset only
   * to its own soundings. */
  selfContext?: string;
  /** Override context discovery (used by tests). */
  contexts?: string[];
}

/** A history request with the instants flattened to strings: Temporal objects
 * do not survive `postMessage` structured cloning. */
export interface SeedWorkerValuesRequest {
  context?: Context;
  from: string;
  to: string;
  resolution?: number;
  pathSpecs: PathSpec[];
}

export interface SeedWorkerContextsRequest {
  from: string;
  to: string;
}

/** Messages the worker sends to the plugin. */
export type SeedWorkerOut =
  | { type: "progress"; progress: SeedProgress }
  | { type: "result"; progress: SeedProgress }
  | { type: "error"; message: string }
  | { type: "debug"; message: string }
  | { type: "getValues"; id: number; req: SeedWorkerValuesRequest }
  | { type: "getContexts"; id: number; req: SeedWorkerContextsRequest };

/** Messages the plugin sends back to the worker. */
export type SeedWorkerIn =
  | { type: "getValuesResult"; id: number; res: ValuesResponse }
  | { type: "getValuesError"; id: number; message: string }
  | { type: "getContextsResult"; id: number; res: ContextsResponse }
  | { type: "getContextsError"; id: number; message: string }
  | { type: "abort" };

/** The slice of a worker's `parentPort` the seed needs, so tests can drive it
 * without a real thread. */
export interface SeedWorkerPort {
  post(message: SeedWorkerOut): void;
  onMessage(handler: (message: SeedWorkerIn) => void): void;
}

interface DiscoveredContext {
  context: Context;
  from?: Temporal.Instant;
  to?: Temporal.Instant;
}

/**
 * Rebuild the tile store in a worker thread.
 *
 * The History API provider lives in the main process, so the worker asks the
 * plugin for each chunk over the port instead of reaching for the provider
 * directly. Everything expensive — folding rows, the tide lookup arithmetic,
 * the SQLite writes and the pyramid rebuild — happens here, off the event loop.
 *
 * The live collector records every vessel that publishes position + depth, not
 * just self. The import mirrors that: it discovers every vessel context with a
 * depth history and seeds each one independently, with its own cursor. Tide is
 * still corrected per row from that row's own timestamp and position; the
 * current vessel's transducer offset is applied only to its own soundings.
 */
export async function runSeedWorker(
  data: SeedWorkerData,
  port: SeedWorkerPort,
): Promise<void> {
  const valuesPending = new Map<
    number,
    { resolve: (res: ValuesResponse) => void; reject: (err: Error) => void }
  >();
  const contextsPending = new Map<
    number,
    { resolve: (res: ContextsResponse) => void; reject: (err: Error) => void }
  >();
  let nextId = 1;
  const controller = new AbortController();

  const abort = () => {
    controller.abort();
    for (const request of valuesPending.values()) {
      request.reject(new Error("aborted"));
    }
    for (const request of contextsPending.values()) {
      request.reject(new Error("aborted"));
    }
    valuesPending.clear();
    contextsPending.clear();
  };

  port.onMessage((message) => {
    if (message.type === "abort") {
      abort();
      return;
    }
    if (
      message.type === "getContextsResult" ||
      message.type === "getContextsError"
    ) {
      const request = contextsPending.get(message.id);
      if (!request) return;
      contextsPending.delete(message.id);
      if (message.type === "getContextsResult") request.resolve(message.res);
      else request.reject(new Error(message.message));
      return;
    }
    const request = valuesPending.get(message.id);
    if (!request) return;
    valuesPending.delete(message.id);
    if (message.type === "getValuesResult") request.resolve(message.res);
    else request.reject(new Error(message.message));
  });

  const history: HistoryApi = {
    getValues(req: ValuesRequest) {
      if (!req.from || !req.to) {
        return Promise.reject(new Error("history request needs from and to"));
      }
      return new Promise<ValuesResponse>((resolve, reject) => {
        const id = nextId++;
        valuesPending.set(id, { resolve, reject });
        port.post({
          type: "getValues",
          id,
          req: {
            context: req.context,
            from: req.from.toString(),
            to: req.to.toString(),
            resolution: req.resolution,
            pathSpecs: req.pathSpecs,
          },
        });
      });
    },
    getContexts(req: ContextsRequest) {
      if (!req.from || !req.to) {
        return Promise.reject(new Error("contexts request needs from and to"));
      }
      return new Promise<ContextsResponse>((resolve, reject) => {
        const id = nextId++;
        contextsPending.set(id, { resolve, reject });
        port.post({
          type: "getContexts",
          id,
          req: { from: req.from.toString(), to: req.to.toString() },
        });
      });
    },
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

    const selfContext = data.selfContext ?? "vessels.self";
    const to = Temporal.Now.instant();
    const contexts = await discoverContexts(
      data,
      history,
      app,
      selfContext,
      to,
      controller.signal,
    );

    const progress: SeedProgress = {
      from: BATHY_EPOCH.toString(),
      to: to.toString(),
      chunks: 0,
      chunksFailed: 0,
      points: 0,
      skipped: 0,
      done: false,
    };

    for (const item of contexts) {
      if (controller.signal.aborted) break;
      const context = item.context;
      // The hull offset belongs to this vessel. Another vessel's transducer
      // position is unknown, so use its reported position unchanged.
      const offset = context === selfContext ? data.offset : undefined;
      const found = await seedFromHistory({
        app,
        store,
        config: data.config,
        context,
        from: item.from ?? BATHY_EPOCH,
        to: item.to ?? to,
        resolution: data.resolution,
        offset,
        tide,
        history,
        // One pyramid rebuild after every context, not after each one.
        rebuild: false,
        signal: controller.signal,
        onProgress: (p) =>
          port.post({
            type: "progress",
            progress: {
              ...p,
              context,
              from: progress.from,
              chunks: progress.chunks + p.chunks,
              chunksFailed: progress.chunksFailed + p.chunksFailed,
              points: progress.points + p.points,
              skipped: progress.skipped + p.skipped,
              done: false,
            },
          }),
      });
      progress.chunks += found.chunks;
      progress.chunksFailed += found.chunksFailed;
      progress.points += found.points;
      progress.skipped += found.skipped;
    }

    if (!controller.signal.aborted) {
      rebuildAncestors(store);
      progress.done = true;
    }
    port.post({ type: "result", progress });
  } catch (err) {
    port.post({ type: "error", message: String(err) });
  } finally {
    store?.close();
  }
}

/** Find every vessel context whose depth history can be paired with a
 * position. The History API exposes a global context list, not a per-context
 * path list, so each vessel is probed with one coarse depth query. */
async function discoverContexts(
  data: SeedWorkerData,
  history: HistoryApi,
  app: ServerAPI,
  selfContext: string,
  to: Temporal.Instant,
  signal: AbortSignal,
): Promise<DiscoveredContext[]> {
  if (data.contexts) {
    return data.contexts.map((context) => ({ context: context as Context }));
  }

  let listed: ContextsResponse = [];
  try {
    listed = await history.getContexts({ from: BATHY_EPOCH, to });
  } catch (err) {
    app.debug("Seed: history context discovery failed: %s", String(err));
  }
  const candidates = [
    ...new Set(
      listed.filter(
        (context) =>
          context.startsWith("vessels.") &&
          // `vessels.self` is an alias for the real context (a UUID or MMSI).
          // Seeding both would duplicate the same history under two cursors.
          (context !== "vessels.self" || selfContext === "vessels.self"),
      ),
    ),
  ];
  if (!candidates.includes(selfContext as Context)) {
    candidates.push(selfContext as Context);
  }
  app.debug(
    "Seed: probing %d vessel contexts for %s",
    candidates.length,
    recordingPath(data),
  );

  const found: DiscoveredContext[] = [];
  let index = 0;
  const probe = async (context: Context) => {
    if (signal.aborted) return;
    try {
      const res = await Promise.race([
        history.getValues({
          context,
          from: BATHY_EPOCH,
          to,
          resolution: DISCOVERY_RESOLUTION_S,
          pathSpecs: [
            {
              path: recordingPath(data) as Path,
              aggregate: "min",
              parameter: [],
            },
          ],
        }),
        new Promise<ValuesResponse>((_, reject) =>
          setTimeout(
            () => reject(new Error("context probe timed out")),
            DISCOVERY_TIMEOUT_MS,
          ),
        ),
      ]);
      if (signal.aborted) return;
      const column = res.values?.findIndex(
        (value) => value.path === recordingPath(data),
      );
      if (column === undefined || column < 0) return;
      const first = res.data.find((row) => typeof row[column + 1] === "number");
      if (!first) return;
      const last = res.data[res.data.length - 1]?.[0];
      found.push({
        context,
        from: instantOf(first[0]),
        to: instantOf(last)?.add({ hours: 24 }),
      });
    } catch {
      // A context the provider cannot answer is not a depth vessel; the other
      // contexts still seed.
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(DISCOVERY_CONCURRENCY, candidates.length) },
      async () => {
        while (!signal.aborted && index < candidates.length) {
          const context = candidates[index++];
          await probe(context);
        }
      },
    ),
  );

  found.sort((a, b) => a.context.localeCompare(b.context));
  app.debug("Seed: found %d vessel contexts with depth history", found.length);
  return found;
}

/** The depth path the live collector records, and therefore the one history
 * must be probed for. */
function recordingPath(data: SeedWorkerData): string {
  const config = data.config;
  return data.tide
    ? "environment.depth.belowSurface"
    : `environment.depth.${config.path}`;
}

function instantOf(value: unknown): Temporal.Instant | undefined {
  try {
    return Temporal.Instant.from(String(value));
  } catch {
    return undefined;
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
