import { transform } from "stream-transform";
import { Writable } from "stream";
import { ServerAPI } from "@signalk/server-api";
import { TransducerOffset } from "./tiles/core/index.js";
import { Config } from "./config.js";
import { createLiveStream, toPrecision } from "./streams/index.js";

export interface CollectorOptions {
  app: ServerAPI;
  config: Config;
  /** The tile writer fed the live soundings. */
  writer: Writable;
  /** Shift each sounding from the reported position to the transducer. */
  offset?: TransducerOffset;
  signal: AbortSignal;
}

/**
 * Pair depth with position once and feed the soundings to the tile writer.
 */
export function createCollector({
  app,
  config,
  writer,
  offset,
  signal,
}: CollectorOptions) {
  const live = createLiveStream(app, config, offset);
  const precise = live.pipe(transform(toPrecision()));
  precise.pipe(writer);

  const destroy = () => {
    live.destroy();
    precise.destroy();
    writer.destroy();
  };

  if (signal.aborted) {
    destroy();
  } else {
    signal.addEventListener("abort", destroy, { once: true });
  }

  return precise;
}
