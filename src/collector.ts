import { transform } from "stream-transform";
import { Writable } from "stream";
import { ServerAPI } from "@signalk/server-api";
import { TransducerOffset } from "./tiles/core/index.js";
import { Config } from "./config.js";
import { createLiveStream, toPrecision } from "./streams/index.js";
import { TideCorrection, recordingDepthPath } from "./tide.js";
import { BathymetryData } from "./types.js";

export interface CollectorOptions {
  app: ServerAPI;
  config: Config;
  /** The tile writer fed the live soundings. */
  writer: Writable;
  /** Shift each sounding from the reported position to the transducer. */
  offset?: TransducerOffset;
  /** Reduce each sounding to a fixed datum, using that sounding's own time and
   * position. */
  tide?: TideCorrection;
  signal: AbortSignal;
}

/**
 * Pair depth with position once and feed the soundings to the tile writer.
 *
 * With tide correction on, the raw depth below the surface is recorded (not the
 * configured depth path, which may already be compensated) and each sounding is
 * reduced to the chosen datum before it reaches the store.
 */
export function createCollector({
  app,
  config,
  writer,
  offset,
  tide,
  signal,
}: CollectorOptions) {
  const live = createLiveStream(
    app,
    config,
    offset,
    recordingDepthPath(config, tide !== undefined),
  );
  const precise = live.pipe(transform(toPrecision()));
  const output = tide ? precise.pipe(transform(tideTransform(tide))) : precise;
  output.pipe(writer);

  const destroy = () => {
    live.destroy();
    precise.destroy();
    output.destroy();
    writer.destroy();
  };

  if (signal.aborted) {
    destroy();
  } else {
    signal.addEventListener("abort", destroy, { once: true });
  }

  return output;
}

/**
 * Async stream handler that corrects each sounding. A sounding is dropped when
 * the tide is unavailable, so a datum grid never mixes in a raw depth.
 */
function tideTransform(tide: TideCorrection) {
  return (
    data: BathymetryData,
    callback: (error?: Error | null, record?: BathymetryData) => void,
  ) => {
    tide
      .correct(data.longitude, data.latitude, data.timestamp, data.depth)
      .then((depth) =>
        callback(null, depth === undefined ? undefined : { ...data, depth }),
      )
      .catch((error: unknown) => callback(error as Error));
  };
}
