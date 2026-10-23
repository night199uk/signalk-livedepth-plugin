import { describe, expect, it } from "vitest";
import {
  buildDepthField,
  createDepthFieldBuilder,
  DEFAULT_CONTOUR_M,
  medianConsecutiveGap,
} from "../../../src/web/shared/bathymetry.js";
import {
  mercX,
  mercY,
  type DepthSample,
} from "../../../src/web/shared/live-depth.js";

const sample = (lon: number, lat: number, depth: number): DepthSample => ({
  lon,
  lat,
  depth,
});

// ~1 m of Web Mercator per 8.98e-6 degrees of longitude near the equator.
const EXTENT = [-2000, -2000, 2000, 2000];

describe("bathymetry createDepthFieldBuilder", () => {
  // The live path adds soundings a few at a time, so the field it accumulates
  // must be identical to building the whole thing in one pass.
  it("matches a one-pass build when samples are added in batches", () => {
    const first = [sample(0, 0, 10), sample(0.009, 0, 20)];
    const later = [sample(0.0045, 0, 15)];
    const options = { cellMetres: 500, coverageCells: 2, shallowBias: 0.3 };
    const onePass = buildDepthField([...first, ...later], EXTENT, options)!;
    const builder = createDepthFieldBuilder(EXTENT, options)!;
    builder.add(first);
    builder.add(later);
    expect(Array.from(builder.field.depth)).toEqual(Array.from(onePass.depth));
  });

  it("reports only the block of cells a new sample reaches", () => {
    const builder = createDepthFieldBuilder(EXTENT, {
      cellMetres: 1000,
      coverageCells: 1,
    })!;
    const rect = builder.add([sample(0, 0, 10)]);
    expect(rect).not.toBeNull();
    const [x0, y0, x1, y1] = rect!;
    // a patch around the sample's cell, not the whole grid
    expect(x1 - x0).toBeLessThan(builder.field.width);
    expect(y1 - y0).toBeLessThan(builder.field.height);
  });
});

describe("bathymetry buildDepthField", () => {
  it("is null for an unusable grid", () => {
    expect(
      buildDepthField([sample(0, 0, 5)], [0, 0, 0, 0], { cellMetres: 10 }),
    ).toBeNull();
    expect(
      buildDepthField([sample(0, 0, 5)], EXTENT, { cellMetres: 0 }),
    ).toBeNull();
    expect(
      buildDepthField([sample(0, 0, 5)], [0, 0, 1], { cellMetres: 10 }),
    ).toBeNull();
  });

  it("fills cells around a sample and leaves the rest uncovered (NaN)", () => {
    const f = buildDepthField([sample(0, 0, 10)], EXTENT, {
      cellMetres: 1000,
      coverageCells: 2,
    });
    expect(f.width).toBe(4);
    expect(f.height).toBe(4);
    // cell (2,2) is centred 707 m from the sample -> covered
    expect(f.depth[2 * 4 + 2]).toBe(10);
    // corner cell is 2121 m away -> beyond the 2000 m radius
    expect(Number.isNaN(f.depth[0])).toBe(true);
  });

  it("interpolates between two soundings", () => {
    const f = buildDepthField(
      [sample(0, 0, 10), sample(0.009, 0, 20)],
      EXTENT,
      {
        cellMetres: 1000,
        coverageCells: 2,
        shallowBias: 0,
      },
    );
    // a cell between the two, in range of both
    const between = f.depth[2 * 4 + 1];
    expect(between).toBeGreaterThan(10);
    expect(between).toBeLessThan(20);
  });

  it("never reports deeper than the shallowest sample in range when biased", () => {
    const f = buildDepthField(
      [sample(0, 0, 10), sample(0.009, 0, 20)],
      EXTENT,
      {
        cellMetres: 1000,
        coverageCells: 2,
        shallowBias: 1,
      },
    );
    const between = f.depth[2 * 4 + 1];
    expect(between).toBe(10);
  });

  it("ignores non-finite and negative samples", () => {
    const f = buildDepthField(
      [sample(0, 0, -5), sample(0, 0, NaN), sample(0, 0, Infinity)],
      EXTENT,
      { cellMetres: 1000 },
    );
    expect([...f.depth].every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("bathymetry sample spacing", () => {
  it("is zero with fewer than two samples", () => {
    expect(medianConsecutiveGap([])).toBe(0);
    expect(medianConsecutiveGap([{ lon: 0, lat: 0 }])).toBe(0);
  });

  it("is the median distance between consecutive samples", () => {
    // ~500 m between the two points near the equator
    expect(
      medianConsecutiveGap([
        { lon: 0, lat: 0 },
        { lon: 0.004492, lat: 0 },
      ]),
    ).toBeCloseTo(500, 0);
  });

  it("bridges a gap when given a coverage radius", () => {
    const a = sample(0, 0, 10);
    const b = sample(0.004492, 0, 20); // ~500 m east
    const extent = [-1000, -1000, 1000, 1000];
    // the cell between them (centre 250 m from each) is uncovered by default
    const dflt = buildDepthField([a, b], extent, { cellMetres: 100 });
    expect(Number.isNaN(dflt.depth[10 * 20 + 12])).toBe(true);
    // a coverage radius of 300 m reaches it
    const bridged = buildDepthField([a, b], extent, {
      cellMetres: 100,
      coverageMetres: 300,
    });
    expect(Number.isNaN(bridged.depth[10 * 20 + 12])).toBe(false);
  });

  it("floors the coverage radius so an anchored cluster is not specks", () => {
    const a = sample(0, 0, 5);
    const extent = [-10, -10, 10, 10];
    // a cell centre ~1.77 m away: outside a 1 m radius (2 cells of 0.5 m) ...
    const bare = buildDepthField([a], extent, {
      cellMetres: 0.5,
      coverageCells: 2,
      coverageMinMetres: 0,
    });
    expect(Number.isNaN(bare.depth[20 * 40 + 23])).toBe(true);
    // ... but inside the default 2 m floor
    const floored = buildDepthField([a], extent, {
      cellMetres: 0.5,
      coverageCells: 2,
    });
    expect(Number.isNaN(floored.depth[20 * 40 + 23])).toBe(false);
  });

  it("spreads a sounding over a wider fill radius, keeping its own cell exact", () => {
    const extent = [-1000, -1000, 1000, 1000];
    const i = 10 * 20 + 15; // a cell ~550 m east of the sounding's cell
    const narrow = buildDepthField([sample(0, 0, 10)], extent, {
      cellMetres: 100,
      coverageMetres: 300,
      coverageMinMetres: 0,
    });
    const wide = buildDepthField([sample(0, 0, 10)], extent, {
      cellMetres: 100,
      coverageMetres: 600,
      coverageMinMetres: 0,
    });
    expect(Number.isNaN(narrow.depth[i])).toBe(true);
    expect(Number.isNaN(wide.depth[i])).toBe(false);
    // the cell the sounding lands in holds its exact depth
    expect(wide.depth[10 * 20 + 10]).toBe(10);
  });

  it("does not spread one depth across a contour", () => {
    const extent = [-100, -100, 100, 100];
    const shallow = sample(0, 0, 5);
    const deep = sample(0.00008983, 0, 20); // ~10 m east
    const f = buildDepthField([shallow, deep], extent, {
      cellMetres: 1,
      coverageMetres: 30,
      shallowBias: 0,
    })!;
    const row = Math.floor((mercY(0) - extent[1]) / 1);
    const ax = Math.floor((mercX(0) - extent[0]) / 1);
    const bx = Math.floor((mercX(0.00008983) - extent[0]) / 1);
    // The shallow sounding's cell is capped near its depth: the deep fill can
    // deepen it by no more than the contour tolerance, never across to 20.
    expect(f.depth[row * f.width + ax]).toBeLessThanOrEqual(
      5 + DEFAULT_CONTOUR_M + 1e-6,
    );
    // Water between them blends linearly.
    const mid = f.depth[row * f.width + Math.floor((ax + bx) / 2)];
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(20);
  });
});
