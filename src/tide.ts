/**
 * Tide compensation for stored soundings.
 *
 * A depth below the surface grows and shrinks with the tide, so it can only be
 * compared across days if it is reduced to a fixed vertical datum. This module
 * looks up the predicted water level at a sounding's own time and position and
 * subtracts it, leaving a depth below the chosen datum that stays valid when
 * the vessel returns.
 *
 * The prediction is harmonic, so the same lookup answers for a live sounding
 * now and for one imported from months ago. `chart` uses the station's own
 * chart datum, which changes with the chart region; `LAT` and `MLLW` are fixed
 * references and are the predictable choices for a map that crosses regions.
 */

import { Temporal } from "@js-temporal/polyfill";

export type TideDatum = "chart" | "LAT" | "MLLW";

/** Datums offered in the plugin settings, in display order. */
export const TIDE_DATUMS: readonly TideDatum[] = ["chart", "LAT", "MLLW"];

/** Store key recording the datum the grid was built in. */
export const TIDE_MODE_KEY = "tide.mode";

/**
 * The datum the tile store is in, or `off` when soundings are stored as
 * measured. Changing this must rebuild the grid: the cells hold depths, not the
 * raw soundings, so a mixed-datum grid cannot be corrected afterwards.
 */
export type TideMode = "off" | TideDatum;

export function tideMode(config: {
  tide?: { enabled?: boolean; datum?: TideDatum };
}): TideMode {
  if (!config.tide?.enabled) return "off";
  const datum = config.tide.datum;
  // The saved config is user input; an unknown datum would silently skip every
  // sounding, so fall back to the default.
  return datum !== undefined && TIDE_DATUMS.includes(datum) ? datum : "LAT";
}

/**
 * The depth path the store records. Tide correction needs the raw water column,
 * so it reads below the surface whatever the configured path says.
 */
export function recordingDepthPath(
  config: { path: string },
  tide: boolean,
): string {
  return tide
    ? "environment.depth.belowSurface"
    : `environment.depth.${config.path}`;
}

/** Whether the stored grid is in a different datum and must be cleared. */
export function shouldResetGrid(
  stored: string | undefined,
  mode: TideMode,
): boolean {
  return stored === undefined ? mode !== "off" : stored !== mode;
}

/** A water level above a datum, and where it came from. */
export interface TideLookup {
  /** Water level above the datum, metres. */
  level: number;
  /** The datum the level is relative to, as the station reports it. */
  datum: string;
  station: string;
}

/** The tide source. A lookup returns undefined when the tide is unavailable. */
export interface TideProvider {
  levelAbove(
    lon: number,
    lat: number,
    time: Temporal.Instant,
    datum: TideDatum,
  ): Promise<TideLookup | undefined>;
}

/** The abbreviation of the datum a grid is stored in. */
export function datumLabel(mode: TideMode): string {
  return mode === "chart" ? "chart datum" : mode === "off" ? "none" : mode;
}

export interface TideCorrection {
  /**
   * Reduce a sounding to the configured datum. Returns undefined when the tide
   * is unavailable, so the caller can skip it rather than store a raw depth in
   * a datum grid.
   */
  correct(
    lon: number,
    lat: number,
    time: Temporal.Instant,
    depth: number,
  ): Promise<number | undefined>;
}

export function createTideCorrection(
  provider: TideProvider,
  datum: TideDatum,
): TideCorrection {
  return {
    async correct(lon, lat, time, depth) {
      const lookup = await provider.levelAbove(lon, lat, time, datum);
      if (!lookup || !Number.isFinite(lookup.level)) return undefined;
      // A seabed above the datum is a drying height; the grid stores depths, so
      // clamp it to the surface rather than dropping the cell.
      return Math.max(0, depth - lookup.level);
    },
  };
}

/** Slackwater's default: beyond this a station predicts water somewhere else. */
export const MAX_STATION_KM = 100;

/** Distance between cached station lookups, in degrees. */
const STATION_CACHE_GRID = 0.01;
const STATION_CACHE_MAX = 512;

/**
 * Predict water levels with the bundled Slackwater engine.
 *
 * A station predictor is cached per small position cell: finding one reads the
 * station database (async, done once), while `getWaterLevelAtTime` is pure
 * arithmetic and answers for any instant, past or future.
 */
export async function createSlackwaterTideProvider(): Promise<TideProvider> {
  const { nearestStation } = await import("slackwater");
  type Predictor = Awaited<ReturnType<typeof nearestStation>>;

  const predictors = new Map<string, Promise<Predictor | undefined>>();

  const predictorFor = (
    lat: number,
    lon: number,
  ): Promise<Predictor | undefined> => {
    const key = `${(Math.round(lat / STATION_CACHE_GRID) * STATION_CACHE_GRID).toFixed(2)},${(
      Math.round(lon / STATION_CACHE_GRID) * STATION_CACHE_GRID
    ).toFixed(2)}`;
    let predictor = predictors.get(key);
    if (!predictor) {
      predictor = nearestStation({
        latitude: lat,
        longitude: lon,
        maxDistance: MAX_STATION_KM,
      })
        .then((station) => (hasTideModel(station) ? station : undefined))
        .catch(() => undefined);
      predictors.set(key, predictor);
      if (predictors.size > STATION_CACHE_MAX) {
        const oldest = predictors.keys().next().value;
        if (oldest !== undefined) predictors.delete(oldest);
      }
    }
    return predictor;
  };

  return {
    async levelAbove(lon, lat, time, datum) {
      const station = await predictorFor(lat, lon);
      if (!station || !datumAvailable(station, datum)) return undefined;
      try {
        const prediction = station.getWaterLevelAtTime({
          time: new Date(time.epochMilliseconds),
          datum: datum === "chart" ? undefined : datum,
        });
        if (!Number.isFinite(prediction.level)) return undefined;
        return {
          level: prediction.level,
          datum: prediction.datum ?? datum,
          station: station.id,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Whether a station can express a level in `datum`. LAT and MLLW are converted
 * through MSL, so a missing MSL makes either unusable. `chart` needs the station
 * to name a chart datum it also has a level for; the engine otherwise falls
 * back to an MSL-relative value, which would be stored as a chart depth.
 */
export function datumAvailable(
  station: { datums?: Record<string, number>; chart_datum?: string },
  datum: TideDatum,
): boolean {
  if (datum === "chart") {
    return (
      station.chart_datum !== undefined &&
      station.datums?.[station.chart_datum] !== undefined
    );
  }
  return (
    station.datums?.[datum] !== undefined && station.datums?.MSL !== undefined
  );
}

/** CHS stations carry identity only; predicting from one gives a flat zero. */
function hasTideModel(station: {
  harmonic_constituents?: unknown[];
  offsets?: unknown;
}): boolean {
  return (
    (station.harmonic_constituents?.length ?? 0) > 0 ||
    station.offsets !== undefined
  );
}
