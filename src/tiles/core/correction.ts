/**
 * Vessel reference point → depth transducer correction.
 *
 * The recorded position is the reference point the server reports as
 * `navigation.position`: the GNSS antenna, or — when the server's
 * `gnssCorrection` is active — the Consistent Common Reference Point (CCRP,
 * midships on the centreline). A depth sounding is measured at the transducer,
 * which sits elsewhere on the hull, so its position must be shifted by the
 * body-frame offset from that reference to the transducer, rotated by the true
 * heading.
 *
 * The caller supplies the offset; this module neither knows nor guesses the
 * reference, so it stays clear of the server's GNSS correction.
 */

/** Body-frame offset of the transducer from the position reference, in metres:
 * `forward` toward the bow, `starboard` to starboard. */
export interface TransducerOffset {
  forward: number;
  starboard: number;
}

/** A lon/lat position. */
export interface LonLat {
  lon: number;
  lat: number;
}

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Shift `position` from the reference point to the transducer, rotating the
 * body-frame `offset` by `heading` (true, radians, clockwise from north).
 * Returns `position` unchanged when there is no heading or no offset.
 */
export function correctToTransducer(
  position: LonLat,
  heading: number | undefined,
  offset: TransducerOffset,
): LonLat {
  if (
    heading === undefined ||
    !Number.isFinite(heading) ||
    (!offset.forward && !offset.starboard)
  ) {
    return position;
  }
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  // +x body (toward bow) points along the heading; +y body (starboard) is 90°
  // clockwise from it.
  const north = offset.forward * cos - offset.starboard * sin;
  const east = offset.forward * sin + offset.starboard * cos;
  const lat = position.lat + (north / EARTH_RADIUS_M) * RAD_TO_DEG;
  const lon =
    position.lon +
    (east / (EARTH_RADIUS_M * Math.cos(position.lat * DEG_TO_RAD))) *
      RAD_TO_DEG;
  // wrap into [-180, 180] so a shift near the antimeridian stays in range
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lon: wrapped, lat };
}
