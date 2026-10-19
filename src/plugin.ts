import { ServerAPI, Plugin, PluginRouter } from "@signalk/server-api";
import { join } from "path";
import { TransducerOffset, TileStore } from "./tiles/core/index.js";
import { schema, Config } from "./config.js";
import { createTileDB, createTileStore } from "./tiles/store.js";
import { createTileWriter } from "./tiles/writer.js";
import { seedFromHistory } from "./tiles/seed.js";
import {
  registerBathymetryRoutes,
  registerSeedRoutes,
  SeedHandle,
  SeedStatus,
} from "./tiles/api.js";
import { registerPlotterExtension } from "./plotterext/provider.js";
import { createCollector } from "./collector.js";

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

export default function createPlugin(app: ServerAPI): Plugin {
  let abortController: AbortController | undefined = undefined;
  // The gridded store served to chart clients. Built in start(), read by the
  // routes registered in registerWithRouter().
  let tileStore: TileStore | undefined;
  let config: Config | undefined;
  let transducer: TransducerOffset | undefined;
  let seedStatus: SeedStatus = { running: false };
  let running = false;
  let routesRegistered = false;

  const runSeed = async (resolution?: number): Promise<void> => {
    if (seedStatus.running) return;
    const store = tileStore;
    const cfg = config;
    if (!store || !cfg) return;

    seedStatus = { running: true };
    app.setPluginStatus("Rebuilding bathymetry tiles from history…");
    try {
      const progress = await seedFromHistory({
        app,
        store,
        config: cfg,
        resolution,
        offset: transducer,
        signal: abortController?.signal,
        onProgress: (p) => {
          seedStatus = { running: !p.done, progress: p };
          app.setPluginStatus(
            `Rebuilding bathymetry tiles: ${p.points} points over ${p.chunks} windows`,
          );
        },
      });
      seedStatus = { running: false, progress };
      app.setPluginStatus(
        `Bathymetry rebuild complete: ${progress.points} points`,
      );
    } catch (err) {
      seedStatus = { running: false, error: String(err) };
      app.setPluginError(`Bathymetry rebuild failed: ${err}`);
    }
  };

  const seed: SeedHandle = { run: runSeed, status: () => seedStatus };

  return {
    id: "signalk-livedepth-plugin",
    name: "LiveDepth",
    description:
      "Serve a gridded bathymetry tile store built from vessel soundings — your own and any other depth-equipped vessel on the server — for a chart plotter's LiveDepth layer.",

    async start(startConfig: Config, restart: (config: object) => void) {
      config = startConfig;
      app.debug("Starting signalk-livedepth-plugin");

      abortController = new AbortController();
      tileStore = createTileStore(
        createTileDB(join(app.getDataDirPath(), `bathymetry-tiles.sqlite`)),
      );
      transducer = resolveTransducerOffset(app, config);

      createCollector({
        app,
        config,
        writer: createTileWriter(tileStore),
        offset: transducer,
        signal: abortController.signal,
      });
      app.setPluginStatus("Collecting depth into the bathymetry tile store");

      running = true;
      // Offer the chart layer to a host chartplotter, and serve the store the
      // layer reads from a top-level, non-admin route.
      registerPlotterExtension(app, () => running);
      if (!routesRegistered) {
        registerBathymetryRoutes(
          app,
          () => tileStore,
          () => ({
            depthPath: config ? `environment.depth.${config.path}` : undefined,
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

      if (startConfig.seed?.run) {
        // One-time rebuild. Clear the trigger when it finishes (or fails) so it
        // doesn't fire again on the next start; an interrupted run resumes from
        // the stored cursor instead of repeating.
        void runSeed(startConfig.seed.resolution).then(() =>
          restart({
            ...startConfig,
            seed: { ...startConfig.seed, run: false },
          }),
        );
      }
    },

    stop() {
      running = false;
      abortController?.abort("Stopping signalk-livedepth-plugin");
      tileStore?.close();
      tileStore = undefined;
    },

    schema() {
      return schema(app);
    },

    registerWithRouter(router: PluginRouter) {
      // The one-time seed trigger stays admin-only, on the plugin's own router;
      // the store the extension reads is served from the top-level route above.
      registerSeedRoutes(router, seed);
    },
  };
}
