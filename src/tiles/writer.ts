import { Writable } from "stream";
import { BathymetryData } from "../types.js";
import { BASE_ZOOM, TileStore, createTileAccumulator } from "./core/index.js";

/** How long soundings are batched before being written to the store. */
export const DEFAULT_FLUSH_MS = 1000;

/**
 * A Writable that folds the live sounding stream into the base-level tiles and,
 * on each flush, min-pools the changed tiles up the pyramid. Writes are batched
 * (one transaction per flush) so a 1 Hz+ sounding rate doesn't turn into a
 * transaction per sample — and, on an SD card, so it doesn't wear one out.
 */
export function createTileWriter(
  store: TileStore,
  {
    baseZoom = BASE_ZOOM,
    flushIntervalMs = DEFAULT_FLUSH_MS,
  }: { baseZoom?: number; flushIntervalMs?: number } = {},
): Writable {
  const accumulator = createTileAccumulator(store, { baseZoom });

  const timer = setInterval(() => accumulator.flush(), flushIntervalMs);
  timer.unref?.();

  return new Writable({
    objectMode: true,
    write(data: BathymetryData, _encoding, callback) {
      try {
        accumulator.add({
          lon: data.longitude,
          lat: data.latitude,
          depth: data.depth,
        });
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      clearInterval(timer);
      try {
        accumulator.flush();
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    // The collector destroys its writers on stop/abort, which does not run
    // `final`. Without this the flush timer outlives the store and the next
    // tick throws "database is not open" from an uncaught timer callback.
    destroy(error, callback) {
      clearInterval(timer);
      callback(error);
    },
  });
}
