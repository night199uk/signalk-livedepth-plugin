import { Temporal } from "@js-temporal/polyfill";

/** Earliest instant the history seed reaches back to. signalk-to-influxdb was
 * first released on 2017-06-28 — the earliest recorded bathymetry. */
export const BATHY_EPOCH = Temporal.Instant.from(
  process.env.BATHY_EPOCH ?? "2017-06-28T00:00:00Z",
);
