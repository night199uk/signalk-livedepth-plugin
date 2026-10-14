import { Path, ServerAPI } from "@signalk/server-api";
import type {
  HistoryApi,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { Config } from "../config.js";
import { BATHY_EPOCH } from "../constants.js";
import { getHistoryAPI, columnsByPath } from "../history.js";
import {
  TileStore,
  TransducerOffset,
  correctToTransducer,
  createTileAccumulator,
  rebuildAncestors,
} from "./core/index.js";

/** Highest granularity we ask the History API for, in seconds. */
export const DEFAULT_SEED_RESOLUTION = 0.1;
/** Hours of history fetched per request, to bound each response. */
export const DEFAULT_SEED_CHUNK_HOURS = 6;
/** Store key holding the instant the last successful seed reached. */
export const SEED_CURSOR_KEY = "seed.cursor";

export interface SeedProgress {
  from: string;
  to: string;
  chunks: number;
  chunksFailed: number;
  points: number;
  done: boolean;
}

export interface SeedOptions {
  app: ServerAPI;
  store: TileStore;
  config: Config;
  /** Earliest instant to seed from; defaults to {@link BATHY_EPOCH}. */
  from?: Temporal.Instant;
  /** Latest instant to seed to; defaults to now. */
  to?: Temporal.Instant;
  /** History resolution in seconds; defaults to {@link DEFAULT_SEED_RESOLUTION}. */
  resolution?: number;
  /** Hours per request; defaults to {@link DEFAULT_SEED_CHUNK_HOURS}. */
  chunkHours?: number;
  /** Override the History API (used by tests). */
  history?: HistoryApi;
  /** Shift each sounding from the recorded position to the transducer. */
  offset?: TransducerOffset;
  signal?: AbortSignal;
  onProgress?: (progress: SeedProgress) => void;
}

/**
 * One-time rebuild of the tile store from the History API at the finest
 * granularity the provider offers. Slow and offline by design — it walks the
 * requested range in chunks and folds every position+depth sounding into the
 * tiles (min-pooling as it goes). The live stream keeps the store current from
 * then on.
 */
export async function seedFromHistory({
  app,
  store,
  config,
  from,
  to = Temporal.Now.instant(),
  resolution = DEFAULT_SEED_RESOLUTION,
  chunkHours = DEFAULT_SEED_CHUNK_HOURS,
  history,
  offset,
  signal,
  onProgress,
}: SeedOptions): Promise<SeedProgress> {
  const api = history ?? (await getHistoryAPI({ app }));
  if (!api) {
    throw new Error("No History API provider is available to seed from");
  }

  const start = from ?? cursorFromStore(store) ?? BATHY_EPOCH;

  const depthPath = `environment.depth.${config.path}`;
  // Deliberately NOT pinned to a source: the seed reconstructs the vessel's
  // whole track, and the active source changes over the record (different GPS
  // units over the years, e.g. raymarine.* in 2025 vs problem-child.* now).
  // Pinning to the current source — as the live collector does — would exclude
  // everything recorded before that source existed. The provider returns the
  // position each depth sounding was recorded with.
  const pathSpecs: ValuesRequest["pathSpecs"] = [
    {
      path: "navigation.position" as Path,
      aggregate: "first",
      parameter: [],
    },
    {
      path: depthPath as Path,
      // signalk-to-influxdb returns null for `first`, so take the shallowest.
      aggregate: "min",
      parameter: [],
    },
    // Heading, only when needed to place the sounding at the transducer.
    ...(offset
      ? [
          {
            path: "navigation.headingTrue" as Path,
            aggregate: "average" as const,
            parameter: [],
          },
        ]
      : []),
  ];

  const accumulator = createTileAccumulator(store, { ancestors: false });
  const progress: SeedProgress = {
    from: start.toString(),
    to: to.toString(),
    chunks: 0,
    chunksFailed: 0,
    points: 0,
    done: false,
  };

  let at = start;
  while (Temporal.Instant.compare(at, to) < 0) {
    if (signal?.aborted) break;
    const next = at.add({ hours: chunkHours });
    const end = Temporal.Instant.compare(next, to) < 0 ? next : to;

    try {
      const res = await api.getValues({
        from: at,
        to: end,
        resolution,
        pathSpecs,
      });
      progress.points += fold(accumulator, res, depthPath, pathSpecs, offset);
      accumulator.flush();
      // Advance the cursor only after the chunk is safely written, so an
      // interrupted seed resumes where it stopped rather than from the start.
      store.setMeta(SEED_CURSOR_KEY, end.toString());
    } catch (err) {
      // A provider can reject a window (e.g. a path with no data); skip it and
      // keep going so one gap doesn't abort the whole rebuild.
      progress.chunksFailed++;
      app.debug("Seed: chunk %s..%s failed: %s", at, end, String(err));
    }

    progress.chunks++;
    onProgress?.(progress);
    at = end;
  }

  // Build the pyramid once from the base tiles just written, rather than
  // re-walking it for every changed tile on every chunk.
  if (!signal?.aborted) {
    rebuildAncestors(store);
  }

  progress.done = true;
  onProgress?.(progress);
  return progress;
}

/** The instant the last seed reached, or undefined when there is none. */
function cursorFromStore(store: TileStore): Temporal.Instant | undefined {
  const value = store.getMeta(SEED_CURSOR_KEY);
  if (!value) return undefined;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return undefined;
  }
}

/** Fold a values response's rows into the accumulator; returns points added. */
function fold(
  accumulator: ReturnType<typeof createTileAccumulator>,
  res: ValuesResponse,
  depthPath: string,
  pathSpecs: ValuesRequest["pathSpecs"],
  offset?: TransducerOffset,
): number {
  const columns = columnsByPath(res.values, pathSpecs);
  const positionColumn = columns.get("navigation.position");
  const depthColumn = columns.get(depthPath);
  const headingColumn = columns.get("navigation.headingTrue");
  if (positionColumn === undefined || depthColumn === undefined) return 0;

  let added = 0;
  for (const row of res.data) {
    const position = row[positionColumn] as [number, number] | null | undefined;
    const [longitude, latitude] = position ?? [];
    const depth = row[depthColumn];
    if (
      typeof depth === "number" &&
      Number.isFinite(depth) &&
      typeof longitude === "number" &&
      Number.isFinite(longitude) &&
      typeof latitude === "number" &&
      Number.isFinite(latitude)
    ) {
      const heading =
        headingColumn === undefined
          ? undefined
          : (row[headingColumn] as number | null | undefined);
      const { lon, lat } = offset
        ? correctToTransducer(
            { lon: longitude, lat: latitude },
            typeof heading === "number" ? heading : undefined,
            offset,
          )
        : { lon: longitude, lat: latitude };
      accumulator.add({
        lon,
        lat,
        depth,
      });
      added++;
    }
  }
  return added;
}
