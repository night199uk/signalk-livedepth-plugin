/** The extension's user settings, shared by the config panel (which edits
 * them), the runtime (which applies them) and the render Worker (which draws
 * with them). Persisted in host state under the extension scope. */

export type DepthSource = "history" | "tiles";

export interface LiveDepthSettings {
  enabled: boolean;
  /** Where the soundings come from: the server's History API (the vessel's own
   * recent track) or the plugin's gridded bathymetry tiles. */
  source: DepthSource;
  /** History look-back window, in hours. */
  historyWindowHours: number;
  /** History sample interval, in seconds. */
  historyResolutionS: number;
  /** Depth (metres) the shading runs to; deeper is left to the chart. */
  shadeLimitMetres: number;
  /** Depth (metres) between isobaths. */
  contourIntervalMetres: number;
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
  historyWindowHours: 1,
  historyResolutionS: 0.1,
  shadeLimitMetres: 10,
  contourIntervalMetres: 1,
  cellPx: 24,
  mergeTolerance: 0.15,
  maxDepthMetres: 100,
  safetyDepthMetres: 3,
};

/** The settings keys, with the bounds the config panel clamps to. */
export const SETTINGS_BOUNDS: Partial<
  Record<keyof LiveDepthSettings, { min: number; max: number; step: number }>
> = {
  historyWindowHours: { min: 0.1, max: 168, step: 0.1 },
  historyResolutionS: { min: 0.01, max: 60, step: 0.01 },
  shadeLimitMetres: { min: 1, max: 200, step: 1 },
  contourIntervalMetres: { min: 0.5, max: 50, step: 0.5 },
  cellPx: { min: 4, max: 128, step: 1 },
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
    if (typeof value === typeof DEFAULT_SETTINGS[key]) {
      (out[key] as unknown) = value;
    }
  }
  return out;
}
