import { ServerAPI, Plugin, PluginRouter } from "@signalk/server-api";
import type { ValuesRequest } from "@signalk/server-api/history";
import { Worker } from "node:worker_threads";
import { join } from "path";
import { Temporal } from "@js-temporal/polyfill";
import { TransducerOffset, TileStore } from "./tiles/core/index.js";
import { schema, formUiSchema, Config } from "./config.js";
import { createTileDB, createTileStore } from "./tiles/store.js";
import { createTileWriter } from "./tiles/writer.js";
import { SEED_CURSOR_KEY } from "./tiles/seed.js";
import type {
  SeedWorkerData,
  SeedWorkerIn,
  SeedWorkerOut,
} from "./tiles/seed-worker.js";
import { getHistoryAPI } from "./history.js";
import {
  TIDE_MODE_KEY,
  TideCorrection,
  TideMode,
  createSlackwaterTideProvider,
  createTideCorrection,
  datumLabel,
  shouldResetGrid,
  tideMode,
} from "./tide.js";
import {
  registerBathymetryRoutes,
  registerSeedRoutes,
  SeedHandle,
  SeedStatus,
} from "./tiles/api.js";
import { registerPlotterExtension } from "./plotterext/provider.js";
import { createCollector } from "./collector.js";

/** How a history rebuild ended. Only a completed or failed run consumes the
 * one-time `seed.run` trigger; an interrupted run leaves it set so the next
 * start resumes from the stored cursor. */
export type SeedOutcome = "completed" | "failed" | "aborted" | "skipped";

/** The vessel's length overall, for locating the reference point the server
 * reports (the CCRP is midships).
 *
 * `design.length` is a compound-value node — `{ value: { overall, hull,
 * waterline } }` — not a leaf, and `getSelfPath` is a `lodash.get` over the raw
 * self model, so `design.length.overall` resolves to nothing. Read the node and
 * take `.value.overall` (matching how the server's own GNSS corrector reads it).
 * Handles `getSelfPath` returning either the value or its node. */
export function readLengthOverall(app: ServerAPI): number | undefined {
  const node = app.getSelfPath("design.length") as
    number | { value?: number | { overall?: number } } | undefined;
  const value = typeof node === "number" ? node : node?.value;
  const overall =
    typeof value === "number"
      ? value
      : (value as { overall?: number } | undefined)?.overall;
  return typeof overall === "number" && Number.isFinite(overall) && overall > 0
    ? overall
    : undefined;
}

/** The vessel's beam, for the debug footprint overlay. `design.beam` is a leaf
 * on most servers but read defensively in case it is a value node. */
export function readVesselBeam(app: ServerAPI): number | undefined {
  const node = app.getSelfPath("design.beam") as
    number | { value?: number } | undefined;
  const value = typeof node === "number" ? node : node?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** The server's GNSS antenna correction mode; `off` unless configured. */
function readGnssCorrection(app: ServerAPI): string {
  // @ts-expect-error: app.config is not a public API
  return app.config?.settings?.gnssCorrection ?? "off";
}

/**
 * The body-frame offset from the reference point the server reports to the
 * transducer, or undefined when correction is off (or can't be located).
 *
 * The server corrects `navigation.position` to the CCRP (midships on the
 * centreline) only when its own `gnssCorrection` is on. When it is off the
 * position is the GNSS antenna, whose body position we do not know — so the
 * offset is meaningless. We still apply what the user configured, but flag it.
 */
export function resolveTransducerOffset(
  app: ServerAPI,
  config: Config,
): TransducerOffset | undefined {
  if (config.transducerCorrection !== "replace") {
    return undefined;
  }
  if (readGnssCorrection(app) === "off") {
    app.setPluginError(
      "Transducer correction is on but the server's GNSS correction is off, so " +
        "the position is the GNSS antenna, not the vessel reference point the " +
        "offset is measured from. Enable GNSS correction (Server → Settings → " +
        "Vessel) or turn this off.",
    );
  }
  const length = readLengthOverall(app);
  if (length === undefined) {
    app.setPluginError(
      "Transducer correction needs the vessel's length overall " +
        "(design.length.overall) to locate the reference point; soundings are " +
        "left where the server reports them.",
    );
    return undefined;
  }
  return {
    // `sounder.y` is the distance from the bow, so a transducer forward of
    // midships sits at a smaller `y` and is a positive shift toward the bow.
    forward: length / 2 - (config.sounder?.y ?? 0),
    starboard: config.sounder?.x ?? 0,
  };
}

/** A parenthetical for rows dropped because the tide was unavailable. */
function skipNote(skipped: number): string {
  return skipped > 0 ? ` (${skipped} skipped: no tide prediction)` : "";
}

/** Overridable only so tests can run the seed without a real worker thread. */
export interface PluginOptions {
  createSeedWorker?: (data: SeedWorkerData) => Worker;
}

export default function createPlugin(
  app: ServerAPI,
  options: PluginOptions = {},
): Plugin {
  const createSeedWorker =
    options.createSeedWorker ??
    ((data: SeedWorkerData) =>
      new Worker(new URL("./tiles/seed-worker.js", import.meta.url), {
        workerData: data,
      }));

  let abortController: AbortController | undefined = undefined;
  // The gridded store served to chart clients. Built in start(), read by the
  // routes registered in registerWithRouter().
  let tileStore: TileStore | undefined;
  let config: Config | undefined;
  let transducer: TransducerOffset | undefined;
  let tide: TideCorrection | undefined;
  /** The datum the store is in; also reported to chart clients. */
  let tideState: TideMode = "off";
  let seedStatus: SeedStatus = { running: false };
  /** Bumped on every start/stop so a seed still winding down cannot overwrite
   * the status of the run that replaced it. */
  let seedGeneration = 0;
  let seedWorker: Worker | undefined;
  let seedSettle: ((outcome: SeedOutcome) => void) | undefined;
  let running = false;
  let routesRegistered = false;

  const runSeed = async (resolution?: number): Promise<SeedOutcome> => {
    if (seedStatus.running) return "skipped";
    const cfg = config;
    if (!tileStore || !cfg) return "skipped";
    // The store's datum is fixed once it holds cells: fold history with the
    // same correction it was built with, and refuse rather than write raw rows
    // into a datum grid.
    if (tideState !== "off" && !tide) {
      seedStatus = { running: false, error: "tide model unavailable" };
      app.setPluginError(
        "Cannot rebuild from history: the tide model is unavailable, so raw depths would be stored in the wrong datum.",
      );
      return "failed";
    }

    // If the plugin is stopped and started while this run is still finishing,
    // the run is superseded: its worker is terminated and the new run owns the
    // status.
    const generation = seedGeneration;
    const current = () => generation === seedGeneration;

    seedStatus = { running: true };
    app.setPluginStatus("Waiting for the history provider…");
    const api = await getHistoryAPI({ app });
    if (!current()) return "aborted";
    if (!api) {
      seedStatus = { running: false, error: "no history provider" };
      app.setPluginError(
        "Cannot rebuild from history: no History API provider is available.",
      );
      return "failed";
    }
    app.setPluginStatus("Rebuilding bathymetry tiles from history…");

    return new Promise<SeedOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: SeedOutcome) => {
        if (settled) return;
        settled = true;
        if (seedSettle === settle) seedSettle = undefined;
        resolve(outcome);
      };
      seedSettle = settle;

      // The worker owns its own SQLite connection and does the expensive
      // folding, writing and pyramid rebuild. History requests are forwarded
      // here because the provider lives in this process.
      const worker = createSeedWorker({
        dbPath: join(app.getDataDirPath(), "bathymetry-tiles.sqlite"),
        config: cfg,
        resolution,
        offset: transducer,
        tide: tideState === "off" ? undefined : tideState,
      });
      seedWorker = worker;

      worker.on("message", (message: SeedWorkerOut) => {
        if (!current()) return;
        if (message.type === "getValues") {
          const req: ValuesRequest = {
            ...message.req,
            from: Temporal.Instant.from(message.req.from),
            to: Temporal.Instant.from(message.req.to),
          };
          api.getValues(req).then(
            (res) => {
              if (!current()) return;
              worker.postMessage({
                type: "getValuesResult",
                id: message.id,
                res,
              } satisfies SeedWorkerIn);
            },
            (err) => {
              if (!current()) return;
              worker.postMessage({
                type: "getValuesError",
                id: message.id,
                message: String(err),
              } satisfies SeedWorkerIn);
            },
          );
          return;
        }
        switch (message.type) {
          case "progress": {
            seedStatus = {
              running: !message.progress.done,
              progress: message.progress,
            };
            app.setPluginStatus(
              `Rebuilding bathymetry tiles: ${message.progress.points} points over ${message.progress.chunks} windows${skipNote(message.progress.skipped)}`,
            );
            break;
          }
          case "result": {
            seedStatus = { running: false, progress: message.progress };
            if (message.progress.done) {
              app.setPluginStatus(
                `Bathymetry rebuild complete: ${message.progress.points} points${skipNote(message.progress.skipped)}`,
              );
              settle("completed");
            } else {
              app.setPluginStatus(
                `Bathymetry rebuild interrupted after ${message.progress.chunks} windows; it will resume on the next start.`,
              );
              settle("aborted");
            }
            break;
          }
          case "error": {
            seedStatus = { running: false, error: message.message };
            app.setPluginError(`Bathymetry rebuild failed: ${message.message}`);
            settle("failed");
            break;
          }
          case "debug": {
            app.debug("[seed worker] %s", message.message);
            break;
          }
        }
      });

      worker.on("error", (err) => {
        if (!current()) return settle("aborted");
        seedStatus = { running: false, error: String(err) };
        app.setPluginError(`Bathymetry rebuild failed: ${err}`);
        settle("failed");
      });

      worker.on("exit", (code) => {
        seedWorker = undefined;
        if (settled) return;
        if (!current()) return settle("aborted");
        seedStatus = { running: false, error: `seed worker exited (${code})` };
        app.setPluginError(
          `Bathymetry rebuild worker exited with code ${code}.`,
        );
        settle(code === 0 ? "aborted" : "failed");
      });
    });
  };

  const seed: SeedHandle = {
    run: async () => {
      await runSeed();
    },
    status: () => seedStatus,
  };

  return {
    id: "signalk-livedepth-plugin",
    name: "LiveDepth",
    description:
      "Serve a gridded bathymetry tile store built from vessel soundings — your own and any other depth-equipped vessel on the server — for a chart plotter's LiveDepth layer.",

    async start(startConfig: Config, restart: (config: object) => void) {
      config = startConfig;
      app.debug("Starting signalk-livedepth-plugin");

      // A new start supersedes any seed still winding down from the previous
      // one (its worker is terminated and its store is closed).
      const previous = seedWorker;
      seedWorker = undefined;
      void previous?.terminate();
      seedGeneration++;
      seedStatus = { running: false };

      abortController = new AbortController();
      tileStore = createTileStore(
        createTileDB(join(app.getDataDirPath(), `bathymetry-tiles.sqlite`)),
      );
      transducer = resolveTransducerOffset(app, config);

      // Build the tide source before the collector starts, so the first
      // sounding already goes through it. The station database loads here, once.
      const configured = tideMode(config);
      tideState = configured;
      tide = undefined;
      let collecting = true;
      if (configured !== "off") {
        try {
          tide = createTideCorrection(
            await createSlackwaterTideProvider(),
            configured,
          );
        } catch (err) {
          // A transient model failure must not clear or relabel an existing
          // grid, nor write raw depths into a datum grid. Keep the stored
          // datum, record nothing, and surface the error.
          collecting = false;
          const stored = tileStore.getMeta(TIDE_MODE_KEY);
          tideState = stored === undefined ? "off" : (stored as TideMode);
          app.setPluginError(
            `Tide correction is on but the tide model could not be loaded ` +
              `(${err}); recording is paused and the existing grid is kept.`,
          );
        }
      }

      if (collecting) {
        // The cells hold depths, not raw soundings, so a grid built in another
        // datum cannot be corrected in place. Clearing is the only way to avoid
        // silently mixing datums; the old seed cursor goes with it.
        const reset = shouldResetGrid(
          tileStore.getMeta(TIDE_MODE_KEY),
          tideState,
        );
        if (reset) {
          tileStore.clear();
          tileStore.setMeta(SEED_CURSOR_KEY, "");
        }
        tileStore.setMeta(TIDE_MODE_KEY, tideState);

        createCollector({
          app,
          config,
          writer: createTileWriter(tileStore),
          offset: transducer,
          tide,
          signal: abortController.signal,
        });
        app.setPluginStatus(
          tideState === "off"
            ? "Collecting depth into the bathymetry tile store"
            : `Collecting depth into the bathymetry tile store, relative to ${datumLabel(tideState)}`,
        );
        if (reset) {
          app.setPluginStatus(
            "The tide datum changed, so the bathymetry grid was cleared. " +
              "Rebuild from history to repopulate it.",
          );
        }
      }

      running = true;
      // Offer the chart layer to a host chartplotter, and serve the store the
      // layer reads from a top-level, non-admin route.
      registerPlotterExtension(app, () => running);
      if (!routesRegistered) {
        registerBathymetryRoutes(
          app,
          () => tileStore,
          () => ({
            depthPath: config
              ? `environment.depth.${tideState === "off" ? config.path : "belowSurface"}`
              : undefined,
            tide: { mode: tideState },
            transducer,
            vessel: {
              loa: readLengthOverall(app),
              beam: readVesselBeam(app),
            },
            debug: {
              vesselFootprint: config?.debug?.vesselFootprint === true,
            },
          }),
        );
        routesRegistered = true;
      }

      if (collecting && startConfig.seed?.run) {
        // One-time rebuild. A completed or failed run consumes the trigger; an
        // interrupted run leaves it set so the next start resumes from the
        // stored cursor instead of repeating.
        void runSeed(startConfig.seed.resolution).then((outcome) => {
          if (outcome === "completed" || outcome === "failed") {
            restart({
              ...startConfig,
              seed: { ...startConfig.seed, run: false },
            });
          }
        });
      }
    },

    stop() {
      running = false;
      seedGeneration++;
      const settle = seedSettle;
      seedSettle = undefined;
      settle?.("aborted");
      const worker = seedWorker;
      seedWorker = undefined;
      void worker?.terminate();
      seedStatus = { running: false };
      abortController?.abort("Stopping signalk-livedepth-plugin");
      tileStore?.close();
      tileStore = undefined;
    },

    schema() {
      return schema(app);
    },

    uiSchema() {
      return formUiSchema(config);
    },

    registerWithRouter(router: PluginRouter) {
      // The one-time seed trigger stays admin-only, on the plugin's own router;
      // the store the extension reads is served from the top-level route above.
      registerSeedRoutes(router, seed);
    },
  };
}
