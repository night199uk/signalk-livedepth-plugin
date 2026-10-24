/** Vector isobars from a depth field, via marching squares.
 *
 * The field is a raster, so the per-fragment isobars it can shade are limited by
 * its resolution. Tracing the same crossings as geometry instead gives lines
 * that stay crisp at any zoom (the vector-tile look). Segments are in the
 * field's EPSG:3857 metres; the renderer maps them to pixels. Cells with an
 * uncovered corner are skipped, so a contour stops at the data edge.
 *
 * Each cell emits only the contour levels it actually straddles, so the cost
 * scales with the number of crossings rather than cells × levels.
 *
 * Levels are walked at the finer of the two intervals; a level that also lands
 * on the major grid is returned as a major (index) contour, the rest as minor.
 */

import type { DepthField } from "./bathymetry.js";

/** One contour segment in world metres: `[x0, y0, x1, y1]`. */
export type ContourSegment = [number, number, number, number];

/** Major (index) and minor contours of a field. */
export interface ContourSet {
  major: ContourSegment[];
  minor: ContourSegment[];
}

/** Whether `level` is a whole multiple of `step` (within float tolerance). */
function onGrid(level: number, step: number): boolean {
  const n = level / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/** Marching-squares contours of `field`: every multiple of `minorStep` is a
 * minor contour, every multiple of `majorStep` a major one, up to `maxLevel`
 * (inclusive). A level on both grids is major. */
export function extractContours(
  field: DepthField,
  minorStep: number,
  majorStep: number,
  maxLevel: number,
): ContourSet {
  const { width, height, depth, extent } = field;
  const result: ContourSet = { major: [], minor: [] };
  const minor = minorStep > 0 ? minorStep : 1;
  const major = majorStep > 0 ? majorStep : minor;
  if (width < 2 || height < 2) return result;
  const cell = (extent[2] - extent[0]) / width;
  const at = (gx: number, gy: number) => depth[gy * width + gx];
  // Corner offsets around a cell, in order (0,0) (1,0) (1,1) (0,1).
  const ox = [0, 1, 1, 0];
  const oy = [0, 0, 1, 1];
  // Walk at the finer interval so both grids are covered.
  const step = Math.min(minor, major);

  for (let gy = 0; gy < height - 1; gy++) {
    for (let gx = 0; gx < width - 1; gx++) {
      const d = [
        at(gx, gy),
        at(gx + 1, gy),
        at(gx + 1, gy + 1),
        at(gx, gy + 1),
      ];
      if (
        !Number.isFinite(d[0]) ||
        !Number.isFinite(d[1]) ||
        !Number.isFinite(d[2]) ||
        !Number.isFinite(d[3])
      ) {
        continue;
      }
      const lo = Math.min(d[0], d[1], d[2], d[3]);
      const hi = Math.max(d[0], d[1], d[2], d[3]);
      if (hi <= lo) continue;
      // The first contour level strictly inside (lo, hi), then every step up.
      const first = Math.floor(lo / step) * step + step;
      for (let level = first; level < hi && level <= maxLevel; level += step) {
        if (level <= lo) continue;
        const out = onGrid(level, major) ? result.major : result.minor;
        // Edge i runs corner i -> i+1 (0:(0-1) 1:(1-2) 2:(2-3) 3:(3-0)).
        const cross: Array<[number, number] | null> = [null, null, null, null];
        const crossed: number[] = [];
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          if (d[i] >= level === d[j] >= level) {
            continue;
          }
          const t = (level - d[i]) / (d[j] - d[i]);
          cross[i] = [
            extent[0] + (gx + ox[i] + (ox[j] - ox[i]) * t) * cell,
            extent[1] + (gy + oy[i] + (oy[j] - oy[i]) * t) * cell,
          ];
          crossed.push(i);
        }
        if (crossed.length === 2) {
          const [a, b] = crossed;
          out.push([...cross[a]!, ...cross[b]!]);
        } else if (crossed.length === 4) {
          // Ambiguous saddle: split by the cell-centre average.
          const centre = (d[0] + d[1] + d[2] + d[3]) / 4;
          if (centre >= level) {
            out.push([...cross[0]!, ...cross[1]!]);
            out.push([...cross[2]!, ...cross[3]!]);
          } else {
            out.push([...cross[0]!, ...cross[3]!]);
            out.push([...cross[1]!, ...cross[2]!]);
          }
        }
      }
    }
  }
  return result;
}
