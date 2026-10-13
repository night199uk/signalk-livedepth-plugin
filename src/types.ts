import { Temporal } from "@js-temporal/polyfill";

/** One depth sounding paired with the position it was recorded at. */
export type BathymetryData = {
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: Temporal.Instant;
  heading?: number;
};
