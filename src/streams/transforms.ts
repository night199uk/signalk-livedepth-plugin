import { BathymetryData } from "../types.js";

/**
 * Fix the precision of incoming data.
 *
 * coordinates - 7 decimal places = ~1.1cm.
 * depth - 3 decimal places = 1mm.
 * heading - 3 decimals = ~0.05 degrees.
 */
export function toPrecision({ coordinates = 7, depth = 3, heading = 3 } = {}) {
  return (data: BathymetryData): BathymetryData => {
    return {
      ...data,
      latitude: parseFloat(data.latitude.toFixed(coordinates)),
      longitude: parseFloat(data.longitude.toFixed(coordinates)),
      depth: parseFloat(data.depth.toFixed(depth)),
      heading: data.heading
        ? parseFloat(data.heading.toFixed(heading))
        : undefined,
    };
  };
}
