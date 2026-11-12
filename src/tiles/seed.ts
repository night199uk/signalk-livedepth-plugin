import { Context, Path, ServerAPI } from "@signalk/server-api";
import type {
  HistoryApi,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { Config } from "../config.js";
import { BATHY_EPOCH } from "../constants.js";
import { getHistoryAPI, columnsByPath } from "../history.js";
import { TideCorrection, recordingDepthPath } from "../tide.js";
import {
  TileStore,
  TransducerOffset,
  correctToTransducer,
  createTileAccumulator,
  rebuildAncestors,
} from "./core/index.js";

/** Highest granularity we ask the History API for, in seconds. */
export const DEFAULT_SEED_RESOLUTION = 0.1;
/** Hours of history fetched per request. Fewer, larger requests keep the
 * provider's per-request overhead down; the fold itself runs in the worker. */
export const DEFAULT_SEED_CHUNK_HOURS = 6;
/** Soundings folded between tile writes. Keeps each write transaction short
 * enough that the live writer sharing the database is not left waiting on a
 * whole chunk. */
export const SEED_FLUSH_ROWS = 10_000;
/** Store key holding the instant the last successful seed reached. */
export const SEED_CURSOR_KEY = "seed.cursor";
/** Store key holding each vessel context's own seed cursor. */
export const SEED_CURSORS_KEY = "seed.cursors";

export interface SeedProgress {
  /** The vessel context this progress is for, when not the legacy self seed. */
  context?: string;
  from: string;
  to: string;
  chunks: number;
  chunksFailed: number;
  points: number;
  /** Rows dropped because the tide was unavailable at their time/position. */
  skipped: number;
  done: boolean;
}

export interface SeedOptions {
  app: ServerAPI;
  store: TileStore;
  config: Config;
  /** Vessel context to seed. Undefined keeps the legacy self-only behaviour. */
  context?: Context;
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
  /** Reduce each sounding to a fixed datum, using the row's own time. */
  tide?: TideCorrection;
  /** Rebuild the pyramid at the end. The multi-context worker disables this
   * per context and rebuilds once after all contexts. */
  rebuild?: boolean;
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
  context,
  from,
  to = Temporal.Now.instant(),
  resolution = DEFAULT_SEED_RESOLUTION,
  chunkHours = DEFAULT_SEED_CHUNK_HOURS,
  history,
  offset,
  tide,
  rebuild = true,
  signal,
  onProgress,
}: SeedOptions): Promise<SeedProgress> {
  const api = history ?? (await getHistoryAPI({ app }));
  if (!api) {
    throw new Error("No History API provider is available to seed from");
  }

  const start = cursorFromStore(store, context) ?? from ?? BATHY_EPOCH;

  // With tide correction on, the raw below-surface depth is the base: the
  // configured path may already be compensated (and only for this vessel now),
  // which would double-correct a historical or imported sounding.
  const depthPath = recordingDepthPath(config, tide !== undefined);
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
    context,
    from: start.toString(),
    to: to.toString(),
    chunks: 0,
    chunksFailed: 0,
    points: 0,
    skipped: 0,
    done: false,
  };

  let at = start;
  while (Temporal.Instant.compare(at, to) < 0) {
    if (signal?.aborted) break;
    const next = at.add({ hours: chunkHours });
    const end = Temporal.Instant.compare(next, to) < 0 ? next : to;

    try {
      const res = await api.getValues({
        ...(context ? { context } : {}),
        from: at,
        to: end,
        resolution,
        pathSpecs,
      });
      const folded = await fold(
        accumulator,
        res,
        depthPath,
        pathSpecs,
        offset,
        tide,
      );
      progress.points += folded.points;
      progress.skipped += folded.skipped;
      accumulator.flush();
      // Advance the cursor only after the chunk is safely written, so an
      // interrupted seed resumes where it stopped rather than from the start.
      setCursor(store, context, end.toString());
    } catch (err) {
      // An abort is not a failed window: stop without advancing the cursor
      // past it, so the chunk is retried on the next start.
      if (signal?.aborted) break;
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
  // re-walking it for every changed tile on every chunk. An interrupted run
  // reports `done: false` so the caller keeps the trigger set and resumes from
  // the cursor on the next start. The multi-context worker disables the rebuild
  // per context and runs it once after every context is done.
  if (!signal?.aborted) {
    if (rebuild) rebuildAncestors(store);
    progress.done = true;
    onProgress?.(progress);
  }

  return progress;
}

/** The instant a context's last completed chunk reached, or undefined. */
function cursorFromStore(
  store: TileStore,
  context?: Context,
): Temporal.Instant | undefined {
  if (context) {
    const cursors = readCursors(store);
    const value = cursors[context];
    if (!value) return undefined;
    try {
      return Temporal.Instant.from(value);
    } catch {
      return undefined;
    }
  }
  const value = store.getMeta(SEED_CURSOR_KEY);
  if (!value) return undefined;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return undefined;
  }
}

/** Persist the last completed chunk for a context (or the legacy self cursor). */
function setCursor(
  store: TileStore,
  context: Context | undefined,
  value: string,
) {
  if (!context) {
    store.setMeta(SEED_CURSOR_KEY, value);
    return;
  }
  const cursors = readCursors(store);
  cursors[context] = value;
  store.setMeta(SEED_CURSORS_KEY, JSON.stringify(cursors));
}

function readCursors(store: TileStore): Record<string, string> {
  const raw = store.getMeta(SEED_CURSORS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    // A malformed cursor map is treated as empty; the affected contexts start
    // from their own first timestamp again.
  }
  return {};
}

/** Fold a values response's rows into the accumulator. */
async function fold(
  accumulator: ReturnType<typeof createTileAccumulator>,
  res: ValuesResponse,
  depthPath: string,
  pathSpecs: ValuesRequest["pathSpecs"],
  offset?: TransducerOffset,
  tide?: TideCorrection,
): Promise<{ points: number; skipped: number }> {
  const columns = columnsByPath(res.values, pathSpecs);
  const positionColumn = columns.get("navigation.position");
  const depthColumn = columns.get(depthPath);
  const headingColumn = columns.get("navigation.headingTrue");
  if (positionColumn === undefined || depthColumn === undefined) {
    return { points: 0, skipped: 0 };
  }

  let points = 0;
  let skipped = 0;
  let sinceFlush = 0;
  for (const row of res.data) {
    const position = row[positionColumn] as [number, number] | null | undefined;
    const [longitude, latitude] = position ?? [];
    const rawDepth = row[depthColumn];
    if (
      typeof rawDepth === "number" &&
      Number.isFinite(rawDepth) &&
      typeof longitude === "number" &&
      Number.isFinite(longitude) &&
      typeof latitude === "number" &&
      Number.isFinite(latitude)
    ) {
      let depth = rawDepth;
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
      if (tide) {
        // The tide is looked up for this row's own instant and position: an
        // imported sounding can be from another vessel, months away. A row with
        // no tide is dropped rather than stored raw in a datum grid.
        const time = instantOf(row[0]);
        if (!time) {
          skipped++;
          continue;
        }
        const corrected = await tide.correct(lon, lat, time, depth);
        if (corrected === undefined) {
          skipped++;
          continue;
        }
        depth = corrected;
      }
      accumulator.add({ lon, lat, depth });
      points++;
      if (++sinceFlush >= SEED_FLUSH_ROWS) {
        accumulator.flush();
        sinceFlush = 0;
      }
    }
  }
  return { points, skipped };
}

/** A history row's timestamp, or undefined when it can't be parsed. */
function instantOf(value: unknown): Temporal.Instant | undefined {
  try {
    return Temporal.Instant.from(String(value));
  } catch {
    return undefined;
  }
}
