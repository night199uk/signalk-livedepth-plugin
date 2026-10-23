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
 */

import type { DepthField } from "./bathymetry.js";

/** One contour segment in world metres: `[x0, y0, x1, y1]`. */
export type ContourSegment = [number, number, number, number];

/** Marching-squares contours of `field` at every multiple of `step` metres up
 * to `maxLevel` (inclusive). */
export function extractContours(
  field: DepthField,
  step: number,
  maxLevel: number,
): ContourSegment[] {
  const { width, height, depth, extent } = field;
  if (width < 2 || height < 2 || !(step > 0)) return [];
  const cell = (extent[2] - extent[0]) / width;
  const at = (gx: number, gy: number) => depth[gy * width + gx];
  // Corner offsets around a cell, in order (0,0) (1,0) (1,1) (0,1).
  const ox = [0, 1, 1, 0];
  const oy = [0, 0, 1, 1];
  const segments: ContourSegment[] = [];

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
          segments.push([...cross[a]!, ...cross[b]!]);
        } else if (crossed.length === 4) {
          // Ambiguous saddle: split by the cell-centre average.
          const centre = (d[0] + d[1] + d[2] + d[3]) / 4;
          if (centre >= level) {
            segments.push([...cross[0]!, ...cross[1]!]);
            segments.push([...cross[2]!, ...cross[3]!]);
          } else {
            segments.push([...cross[0]!, ...cross[3]!]);
            segments.push([...cross[1]!, ...cross[2]!]);
          }
        }
      }
    }
  }
  return segments;
}
