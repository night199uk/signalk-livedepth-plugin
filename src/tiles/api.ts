import type { Request, Response } from "express";
import type { PluginRouter } from "@signalk/server-api";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  RECORD_BYTES,
  TILE_SIZE,
  TileStore,
  encodeTile,
} from "signalk-livedepth-tiles";
import { SeedProgress } from "./seed.js";

/** Wire format of a `/bathymetry/tiles` response. */
export const BATHYMETRY_FORMAT = "sparse-v1";

/** Extra fields a client needs to mirror the store (depth path, offsets, …). */
export type BathymetryMeta = Record<string, unknown>;

/** Status of the one-time history seed, as served to the admin UI. */
export interface SeedStatus {
  running: boolean;
  progress?: SeedProgress;
  error?: string;
}

/**
 * Admin-only handle for the one-time history seed. `run` resolves when the seed
 * finishes; `status` reflects the current run. Registered directly on the router
 * (no `access()`) so the trigger requires admin.
 */
export interface SeedHandle {
  run(): Promise<void>;
  status(): SeedStatus;
}

/**
 * Serve the gridded store to a chart client.
 *
 * Mounted by the Signal K server at `/plugins/<pluginId>`, e.g.
 * `GET /plugins/crowd-depth/bathymetry/tiles/20/12345/6789`. A client seeds the
 * current view from these tiles, then keeps its own copy up to date from the
 * same live `navigation.position` + `environment.depth.*` stream the plugin
 * consumes.
 *
 * `getStore`/`getMeta` are read per request because the router may be
 * registered before the plugin's `start()` has built the store.
 */
export function registerBathymetryRoutes(
  router: PluginRouter,
  getStore: () => TileStore | undefined,
  getMeta: () => BathymetryMeta = () => ({}),
  seed?: SeedHandle,
): void {
  router
    .access("readonly")
    .get("/bathymetry/meta", (_req: Request, res: Response) => {
      res.json({
        format: BATHYMETRY_FORMAT,
        baseZoom: BASE_ZOOM,
        minZoom: MIN_ZOOM,
        tileSize: TILE_SIZE,
        recordBytes: RECORD_BYTES,
        ...getMeta(),
      });
    });

  router
    .access("readonly")
    .get("/bathymetry/tiles/:z/:x/:y", (req: Request, res: Response) => {
      const store = getStore();
      if (!store) {
        res.status(503).json({ error: "bathymetry store not ready" });
        return;
      }
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      const n = Math.pow(2, z);
      if (
        !Number.isInteger(z) ||
        z < MIN_ZOOM ||
        z > BASE_ZOOM ||
        !Number.isInteger(x) ||
        x < 0 ||
        x >= n ||
        !Number.isInteger(y) ||
        y < 0 ||
        y >= n
      ) {
        res.status(400).json({ error: "invalid tile coordinates" });
        return;
      }
      const cells = store.read(z, x, y);
      if (!cells || cells.size === 0) {
        res.status(404).end();
        return;
      }
      // Send a Buffer, not the Uint8Array `encodeTile` returns: express's
      // `res.send` JSON-encodes anything that isn't a Buffer or string (it
      // becomes `{"0":…,"1":…}`), so the client would decode the JSON text as
      // sparse records. `Buffer` is a Uint8Array subclass, so it sends the
      // bytes verbatim.
      res
        .set("Content-Type", "application/octet-stream")
        .set("Cache-Control", "no-cache")
        .send(Buffer.from(encodeTile(cells)));
    });

  if (seed) {
    // Registered without access() so the trigger requires admin.
    router.get("/bathymetry/seed", (_req: Request, res: Response) => {
      res.json(seed.status());
    });

    router.post("/bathymetry/seed", (_req: Request, res: Response) => {
      // Fire and forget; the client polls GET for progress.
      seed.run().catch(() => {});
      res.status(202).json(seed.status());
    });
  }
}
