import { expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  createTideCorrection,
  datumAvailable,
  recordingDepthPath,
  shouldResetGrid,
  tideMode,
  type TideProvider,
} from "../src/tide.js";

const time = Temporal.Instant.from("2026-09-01T12:00:00Z");

function fixedProvider(level: number | undefined): TideProvider {
  return {
    levelAbove: async () =>
      level === undefined ? undefined : { level, datum: "LAT", station: "x" },
  };
}

test("tide correction is off unless enabled, and defaults to LAT", () => {
  expect(tideMode({})).toBe("off");
  expect(tideMode({ tide: { enabled: false, datum: "MLLW" } })).toBe("off");
  expect(tideMode({ tide: { enabled: true } })).toBe("LAT");
  expect(tideMode({ tide: { enabled: true, datum: "MLLW" } })).toBe("MLLW");
  expect(tideMode({ tide: { enabled: true, datum: "chart" } })).toBe("chart");
  expect(
    tideMode({ tide: { enabled: true, datum: "nonsense" as never } }),
  ).toBe("LAT");
});

test("the store records the raw below-surface depth when correcting tides", () => {
  expect(recordingDepthPath({ path: "belowTransducer" }, false)).toBe(
    "environment.depth.belowTransducer",
  );
  expect(recordingDepthPath({ path: "belowTransducer" }, true)).toBe(
    "environment.depth.belowSurface",
  );
});

test("a different datum requires clearing the grid, but a first run does not", () => {
  // A fresh grid in the old default (off) is already raw, so leave it.
  expect(shouldResetGrid(undefined, "off")).toBe(false);
  // Enabling correction on an existing raw grid must clear it.
  expect(shouldResetGrid(undefined, "LAT")).toBe(true);
  expect(shouldResetGrid("off", "LAT")).toBe(true);
  expect(shouldResetGrid("LAT", "off")).toBe(true);
  expect(shouldResetGrid("LAT", "MLLW")).toBe(true);
  expect(shouldResetGrid("LAT", "LAT")).toBe(false);
});

test("correction subtracts the tide above the chosen datum", async () => {
  const correction = createTideCorrection(fixedProvider(1.5), "LAT");
  await expect(correction.correct(0, 0, time, 10)).resolves.toBe(8.5);
});

test("a sounding with no tide prediction is dropped", async () => {
  const correction = createTideCorrection(fixedProvider(undefined), "LAT");
  await expect(correction.correct(0, 0, time, 10)).resolves.toBeUndefined();
});

test("a drying height clamps to the datum instead of going negative", async () => {
  const correction = createTideCorrection(fixedProvider(3), "LAT");
  await expect(correction.correct(0, 0, time, 2)).resolves.toBe(0);
});

test("LAT and MLLW need both the datum and MSL; chart needs a named datum", () => {
  const station = {
    datums: { LAT: 0.4, MLLW: 0.5, MSL: 0.7 },
    chart_datum: "LAT",
  };
  expect(datumAvailable(station, "LAT")).toBe(true);
  expect(datumAvailable(station, "MLLW")).toBe(true);
  expect(datumAvailable(station, "chart")).toBe(true);
  expect(
    datumAvailable(
      { datums: { LAT: 0.4, MSL: 0.7 }, chart_datum: "MLLW" },
      "chart",
    ),
  ).toBe(false);
  expect(datumAvailable({ datums: { LAT: 0.4, MSL: 0.7 } }, "chart")).toBe(
    false,
  );
  expect(datumAvailable({ datums: { LAT: 0.4 } }, "LAT")).toBe(false);
  expect(datumAvailable({ datums: { MLLW: 0.5 } }, "MLLW")).toBe(false);
  expect(datumAvailable({}, "LAT")).toBe(false);
});
