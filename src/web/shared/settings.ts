/** The extension's user settings, shared by the config panel (which edits
 * them), the runtime (which applies them) and the render Worker (which draws
 * with them). Persisted in host state under the extension scope. */

export type DepthSource = "history" | "tiles";

/** Overlay render quality. `auto` measures the worker's own frame cost and
 * scales to a budget; the rest pin a scale, so a weak GPU (a laptop iGPU) can
 * be dialled down and a fast one dialled up. */
export type DepthQuality = "auto" | "high" | "balanced" | "low";

export interface LiveDepthSettings {
  enabled: boolean;
  /** Where the soundings come from: the server's History API (the vessel's own
   * recent track) or the plugin's gridded bathymetry tiles. */
  source: DepthSource;
  /** Overlay render quality (see {@link DepthQuality}). */
  quality: DepthQuality;
  /** Render the shaded surface at the host's full requested size, ignoring the
   * render-quality scale. */
  fullResolution: boolean;
  /** Draw isobars as vector polylines (crisp at any zoom) instead of the
   * per-fragment raster approximation. */
  vectorContours: boolean;
  /** Antialias the WebGL surface, so the coverage/discard edges are smooth. */
  msaa: boolean;
  /** Cap on either depth-field dimension. Higher resolves finer contours at the
   * cost of memory and build time. */
  fieldCells: number;
  /** Vector isobar line width, in screen pixels. */
  contourWidthPx: number;
  /** History look-back window, in hours. */
  historyWindowHours: number;
  /** History sample interval, in seconds. */
  historyResolutionS: number;
  /** Depth (metres) the shading runs to; deeper is left to the chart. */
  shadeLimitMetres: number;
  /** Depth (metres) between isobaths. */
  contourIntervalMetres: number;
  /** Radius (metres) over which a sounding fills water with no samples of its
   * own, so a single pass paints a readable swath instead of a hairline track.
   * Measured cells keep their own depth; the fill fades linearly to nothing at
   * this radius. 0 disables the fill. */
  fillMetres: number;
  /** Grid cell size in screen pixels; also the base label size. */
  cellPx: number;
  /** Fractional depth difference (0.15 = 15%) within which adjacent cells
   * merge into one group. */
  mergeTolerance: number;
  /** Samples deeper than this (metres) are not drawn. */
  maxDepthMetres: number;
  /** Samples at or below this depth (metres) are marked individually. */
  safetyDepthMetres: number;
}

export const DEFAULT_SETTINGS: LiveDepthSettings = {
  enabled: true,
  source: "history",
  quality: "auto",
  fullResolution: true,
  vectorContours: true,
  msaa: true,
  fieldCells: 1024,
  contourWidthPx: 1.5,
  historyWindowHours: 1,
  historyResolutionS: 0.1,
  shadeLimitMetres: 10,
  contourIntervalMetres: 1,
  fillMetres: 6,
  cellPx: 24,
  mergeTolerance: 0.15,
  maxDepthMetres: 100,
  safetyDepthMetres: 3,
};

/** The render scale (fraction of the host's requested frame size) each fixed
 * quality pins; `auto` is driven by the worker's own measurement instead. */
export const QUALITY_SCALE: Record<Exclude<DepthQuality, "auto">, number> = {
  high: 1,
  balanced: 0.6,
  low: 0.4,
};

/** The allowed values of the settings that are a closed set of strings. */
const ENUM_VALUES: Partial<Record<keyof LiveDepthSettings, readonly string[]>> =
  {
    source: ["history", "tiles"],
    quality: ["auto", "high", "balanced", "low"],
  };

/** The settings keys, with the bounds the config panel clamps to. */
export const SETTINGS_BOUNDS: Partial<
  Record<keyof LiveDepthSettings, { min: number; max: number; step: number }>
> = {
  historyWindowHours: { min: 0.1, max: 168, step: 0.1 },
  historyResolutionS: { min: 0.01, max: 60, step: 0.01 },
  shadeLimitMetres: { min: 1, max: 200, step: 1 },
  contourIntervalMetres: { min: 0.5, max: 50, step: 0.5 },
  fillMetres: { min: 0, max: 20, step: 1 },
  cellPx: { min: 4, max: 128, step: 1 },
  fieldCells: { min: 256, max: 4096, step: 256 },
  contourWidthPx: { min: 0.5, max: 6, step: 0.5 },
  mergeTolerance: { min: 0, max: 1, step: 0.01 },
  maxDepthMetres: { min: 1, max: 500, step: 1 },
  safetyDepthMetres: { min: 0, max: 50, step: 0.5 },
};

/** Merge stored state over the defaults, ignoring unknown/ill-typed keys. */
export function mergeSettings(
  stored: Record<string, unknown> | undefined,
): LiveDepthSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (!stored) {
    return out;
  }
  for (const key of Object.keys(
    DEFAULT_SETTINGS,
  ) as (keyof LiveDepthSettings)[]) {
    const value = stored[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) {
      continue;
    }
    const allowed = ENUM_VALUES[key];
    if (allowed && !allowed.includes(value as string)) {
      continue;
    }
    (out[key] as unknown) = value;
  }
  return out;
}
