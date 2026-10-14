import { Context, Delta, Path, ServerAPI } from "@signalk/server-api";
import { PassThrough } from "stream";
import { correctToTransducer, TransducerOffset } from "../tiles/core/index.js";
import { Config } from "../config.js";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";

/** Maximum age of last position fix for a depth to be saved */
const ttl = 2000;

/**
 * Subscribe to the vessel's own depth and pair each sounding with the last
 * position fix, emitting `BathymetryData` objects. When `offset` is given, the
 * position is shifted from the vessel reference point to the transducer.
 */
export function createLiveStream(
  app: ServerAPI,
  config: Config,
  offset?: TransducerOffset,
) {
  const path = `environment.depth.${config.path}` as Path;

  app.debug(`Collecting depth data from environment.depth.${path}`);

  const unsubscribes: (() => void)[] = [];

  const stream = new PassThrough({ objectMode: true });
  stream.on("close", () => {
    unsubscribes.forEach((f) => f());
  });

  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path, policy: "instant" }],
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      delta.updates.forEach((update) => {
        const timestamp = Temporal.Instant.from(
          update.timestamp ?? Temporal.Now.instant(),
        );
        const position = app.getSelfPath("navigation.position") as
          | {
              value: { longitude: number; latitude: number };
              timestamp: string;
            }
          | undefined;
        let heading = app.getSelfPath("navigation.headingTrue") as
          { value: number; timestamp: string } | undefined;

        if ("values" in update) {
          update.values.forEach(({ value }) => {
            if (!value) return;

            if (!position)
              return app.debug("No position data, ignoring depth data");
            if (isStale(position, timestamp, ttl))
              return app.debug("Stale position data, ignoring depth data");

            if (heading && isStale(heading, timestamp, ttl)) {
              app.debug("Stale heading data, discarding");
              heading = undefined;
            }

            const { lon, lat } = offset
              ? correctToTransducer(
                  {
                    lon: position.value.longitude,
                    lat: position.value.latitude,
                  },
                  heading?.value,
                  offset,
                )
              : { lon: position.value.longitude, lat: position.value.latitude };

            stream.push({
              longitude: lon,
              latitude: lat,
              depth: value as number,
              timestamp,
              heading: heading?.value,
            } satisfies BathymetryData);
          });
        }
      });
    },
  );

  return stream;
}

function isStale(
  object: { timestamp: string },
  timestamp: Temporal.Instant,
  ttl: number,
) {
  return (
    !object?.timestamp ||
    Temporal.Instant.from(object.timestamp).epochMilliseconds <
      timestamp.subtract({ milliseconds: ttl }).epochMilliseconds
  );
}
