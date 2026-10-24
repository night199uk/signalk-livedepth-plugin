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
    const { major, minor } = extractContours(field([0, 10, 0, 10]), 5, 5, 5);
    expect(minor).toHaveLength(0);
    expect(major).toHaveLength(1);
    const [x0, y0, x1, y1] = major[0];
    expect(x0).toBeCloseTo(0.5);
    expect(x1).toBeCloseTo(0.5);
    expect(Math.abs(y1 - y0)).toBeCloseTo(1);
  });

  it("splits levels into major (index) and minor contours", () => {
    // 0..7 crosses minors 1,2,3,4,6 and the major at 5
    const { major, minor } = extractContours(field([0, 7, 0, 7]), 1, 5, 10);
    expect(major).toHaveLength(1);
    expect(minor).toHaveLength(5);
  });

  it("emits nothing when no level falls strictly inside the cell", () => {
    const { major, minor } = extractContours(field([1, 2, 1, 2]), 1, 10, 10);
    expect(major).toHaveLength(0);
    expect(minor).toHaveLength(0);
  });

  it("stops at an uncovered cell", () => {
    const { major, minor } = extractContours(
      field([0, 10, NaN, 10]),
      1,
      10,
      10,
    );
    expect(major).toHaveLength(0);
    expect(minor).toHaveLength(0);
  });

  it("honours the maximum level", () => {
    const { major, minor } = extractContours(
      field([20, 30, 20, 30]),
      1,
      10,
      10,
    );
    expect(major).toHaveLength(0);
    expect(minor).toHaveLength(0);
  });

  it("treats a level on both grids as major", () => {
    // 1 ft minor, 5 ft major, in metres: 1.524 m is on both grids
    const { major, minor } = extractContours(
      field([0, 1.524, 0, 1.524]),
      0.3048,
      1.524,
      10,
    );
    expect(major).toHaveLength(1);
    expect(minor).toHaveLength(4);
  });
});
