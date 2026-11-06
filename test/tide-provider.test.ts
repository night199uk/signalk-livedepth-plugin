import { expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";

// An older Slackwater beta returns the predictor synchronously; the provider
// must accept both shapes, because a Signal K server may pin a different
// version than this package depends on.
vi.mock("slackwater", () => ({
  nearestStation: () => ({
    id: "station",
    chart_datum: "LAT",
    datums: { LAT: 0.2, MLLW: 0.4, MSL: 0.7 },
    harmonic_constituents: [{}],
    getWaterLevelAtTime: ({ datum }: { datum?: string }) => ({
      level: datum === "MLLW" ? 0.1 : 0.2,
      datum: datum ?? "LAT",
    }),
  }),
}));

import { createSlackwaterTideProvider } from "../src/tide.js";

const time = Temporal.Instant.from("2026-09-01T12:00:00Z");

test("accepts a synchronously-returning nearestStation", async () => {
  const provider = await createSlackwaterTideProvider();
  await expect(provider.levelAbove(0, 0, time, "LAT")).resolves.toEqual({
    level: 0.2,
    datum: "LAT",
    station: "station",
  });
});

test("passes the chosen datum to the predictor", async () => {
  const provider = await createSlackwaterTideProvider();
  await expect(provider.levelAbove(0, 0, time, "MLLW")).resolves.toEqual({
    level: 0.1,
    datum: "MLLW",
    station: "station",
  });
});
