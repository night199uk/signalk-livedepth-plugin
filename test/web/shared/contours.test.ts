import { describe, expect, it } from "vitest";
import { extractContours } from "../../../src/web/shared/contours.js";
import type { DepthField } from "../../../src/web/shared/bathymetry.js";

/** One 2x2 cell: row-major `[d00, d10, d01, d11]` over a 2 m extent. */
const field = (depth: number[]): DepthField => ({
  width: 2,
  height: 2,
  extent: [0, 0, 2, 2],
  depth: Float32Array.from(depth),
});

describe("extractContours", () => {
  it("emits a segment where the depth crosses a level", () => {
    // d00=0 d10=10 / d01=0 d11=10 -> a vertical crossing at x = 0.5
    const segs = extractContours(field([0, 10, 0, 10]), 5, 5);
    expect(segs).toHaveLength(1);
    const [x0, y0, x1, y1] = segs[0];
    expect(x0).toBeCloseTo(0.5);
    expect(x1).toBeCloseTo(0.5);
    expect(Math.abs(y1 - y0)).toBeCloseTo(1);
  });

  it("emits nothing when no level falls strictly inside the cell", () => {
    expect(extractContours(field([1, 2, 1, 2]), 1, 10)).toHaveLength(0);
  });

  it("stops at an uncovered cell", () => {
    expect(extractContours(field([0, 10, NaN, 10]), 1, 10)).toHaveLength(0);
  });

  it("tracks every level a cell straddles", () => {
    // 0..4 crosses levels 1, 2 and 3
    expect(extractContours(field([0, 4, 0, 4]), 1, 10)).toHaveLength(3);
  });

  it("honours the maximum level", () => {
    expect(extractContours(field([20, 30, 20, 30]), 1, 10)).toHaveLength(0);
  });
});
