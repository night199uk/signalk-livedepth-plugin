import { Context, Delta, Path, ServerAPI } from "@signalk/server-api";
import { PassThrough } from "stream";
import { correctToTransducer, TransducerOffset } from "../tiles/core/index.js";
import { Config } from "../config.js";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";

/** Maximum age of last position fix for a depth to be saved */
const ttl = 2000;

/** How often to look for vessels that have started (or stopped) publishing. */
const scanIntervalMs = 15000;

type PositionNode = {
  value: { longitude: number; latitude: number };
  timestamp: string;
};

type HeadingNode = { value: number; timestamp: string };

type VesselNode = {
  environment?: { depth?: Record<string, unknown> };
  navigation?: { position?: unknown };
};

/** A vessel's own fix and heading, subscribed alongside its depth so a
 * sounding is paired with the position it was recorded at. */
const POSITION = "navigation.position" as Path;
const HEADING = "navigation.headingTrue" as Path;
/** Course over ground — the heading fallback for a vessel with no compass. */
const COURSE = "navigation.courseOverGroundTrue" as Path;

/** The `[lon, lat]` of a position in either raw (`{ longitude, latitude }`) or
 * data-model node (`{ value: { … }, timestamp }`) form. */
function positionOf(
  value: unknown,
): { longitude: number; latitude: number } | undefined {
  const v = (value as { value?: unknown } | undefined)?.value ?? value;
  if (!v || typeof v !== "object") return undefined;
  const { longitude, latitude } = v as {
    longitude?: unknown;
    latitude?: unknown;
  };
  if (typeof longitude === "number" && typeof latitude === "number") {
    return { longitude, latitude };
  }
  return undefined;
}

/**
 * Subscribe to every vessel that publishes a depth on the configured datum,
 * pair each sounding with that vessel's own position fix, and emit
 * `BathymetryData`. Vessels are discovered from the data model: one that
 * publishes a depth is recorded, an AIS target (position but no depth) is not,
 * so a tender or a second sounder-equipped vessel is picked up automatically.
 *
 * The vessel's position and heading are subscribed alongside the depth, so a
 * sounding is paired with the fix it was recorded at — including a replayed
 * (back-dated) sounding from a vessel that was offline, which the data model's
 * current position would place wrongly. The model is the fallback before the
 * stream has carried a fix. A vessel with no compass has only course over
 * ground, so that is the heading fallback.
 *
 * The transducer `offset` describes this vessel's hull, so it is applied only
 * to this vessel's own soundings.
 */
export function createLiveStream(
  app: ServerAPI,
  config: Config,
  offset?: TransducerOffset,
) {
  const depthPath = `environment.depth.${config.path}` as Path;
  const include = new Set(config.vessels?.include ?? []);
  const exclude = new Set(config.vessels?.exclude ?? []);
  const selfUrn = app.getSelfPath("uuid") as string | undefined;
  const selfContext = selfUrn ? `vessels.${selfUrn}` : "vessels.self";

  app.debug(`Collecting ${depthPath} from every vessel that publishes it`);

  const stream = new PassThrough({ objectMode: true });
  const unsubscribes = new Map<string, () => void>();
  let scanTimer: ReturnType<typeof setInterval> | undefined;

  const isSelf = (context: string) =>
    context === "vessels.self" || context === selfContext;

  const wanted = (context: string) =>
    !exclude.has(context) && (include.size === 0 || include.has(context));

  const readVessel = (context: string, path: string): unknown =>
    isSelf(context) ? app.getSelfPath(path) : app.getPath(`${context}.${path}`);

  // The last fix seen per vessel on the stream, so a sounding is paired with
  // the position it was recorded at — and a replayed (back-dated) sounding uses
  // the replayed position, not the vessel's current one.
  const fixes = new Map<
    string,
    { longitude: number; latitude: number; timestamp: string }
  >();
  const headings = new Map<string, HeadingNode>();
  // Course over ground, the heading fallback for a vessel with no compass.
  const courses = new Map<string, HeadingNode>();

  const collect = (context: string, delta: Delta) => {
    delta.updates.forEach((update) => {
      if (!("values" in update)) return;
      const ts = update.timestamp ?? Temporal.Now.instant().toString();
      const timestamp = Temporal.Instant.from(ts);

      // Absorb the update's own position/heading first, so a depth sounding in
      // the same update pairs with the fix it was recorded at.
      update.values.forEach(({ path, value }) => {
        if (path === POSITION) {
          const p = positionOf(value);
          if (p) fixes.set(context, { ...p, timestamp: ts });
        } else if (path === HEADING && typeof value === "number") {
          headings.set(context, { value, timestamp: ts });
        } else if (path === COURSE && typeof value === "number") {
          courses.set(context, { value, timestamp: ts });
        }
      });

      // Pair soundings with the last fix from the stream, or the data model
      // before the stream has carried one (a vessel discovered but silent so
      // far).
      let fix = fixes.get(context);
      if (!fix) {
        const node = readVessel(context, POSITION) as PositionNode | undefined;
        const p = positionOf(node);
        if (p) fix = { ...p, timestamp: node?.timestamp ?? ts };
      }
      // A vessel with no compass has only course over ground; use it as the
      // heading fallback (it is the direction of travel, so meaningless while
      // stopped, but there is nothing else).
      let heading = headings.get(context) ?? courses.get(context);
      if (!heading) {
        heading =
          (readVessel(context, HEADING) as HeadingNode | undefined) ??
          (readVessel(context, COURSE) as HeadingNode | undefined);
      }

      update.values.forEach(({ path, value }) => {
        // The subscription carries position and heading too; only a depth value
        // is a sounding.
        if (path !== depthPath) return;
        if (!value) return;

        if (!fix)
          return app.debug(`No position for ${context}, ignoring depth data`);
        if (isStale(fix, timestamp, ttl))
          return app.debug(
            `Stale position for ${context}, ignoring depth data`,
          );

        if (heading && isStale(heading, timestamp, ttl)) {
          app.debug("Stale heading data, discarding");
          heading = undefined;
        }

        const vesselOffset = isSelf(context) ? offset : undefined;
        const { lon, lat } = vesselOffset
          ? correctToTransducer(
              { lon: fix.longitude, lat: fix.latitude },
              heading?.value,
              vesselOffset,
            )
          : { lon: fix.longitude, lat: fix.latitude };

        stream.push({
          longitude: lon,
          latitude: lat,
          depth: value as number,
          timestamp,
          heading: heading?.value,
          context,
        } satisfies BathymetryData);
      });
    });
  };

  const subscribe = (context: string) => {
    const unsubs: (() => void)[] = [];
    app.subscriptionmanager.subscribe(
      {
        context: context as Context,
        subscribe: [
          { path: depthPath, policy: "instant" },
          { path: POSITION, policy: "instant" },
          { path: HEADING, policy: "instant" },
          { path: COURSE, policy: "instant" },
        ],
      },
      unsubs,
      (error) => app.error(error as string),
      (delta: Delta) => collect(context, delta),
    );
    unsubscribes.set(context, () => unsubs.forEach((f) => f()));
    app.debug(`Recording ${depthPath} from ${context}`);
  };

  const scan = () => {
    const vessels = app.getPath("vessels") as
      Record<string, VesselNode> | undefined;
    if (!vessels) return;

    for (const [key, node] of Object.entries(vessels)) {
      const context = key === "self" ? "vessels.self" : `vessels.${key}`;
      if (unsubscribes.has(context) || !wanted(context)) continue;
      // A depth on the chosen datum is what makes a vessel worth recording;
      // AIS targets have a position but never a depth.
      if (!node?.environment?.depth?.[config.path]) continue;
      if (!node?.navigation?.position) continue;
      subscribe(context);
    }

    // A vessel is never unsubscribed for going quiet. It may be offline and
    // replay its buffered deltas when it reconnects, and the data model entry
    // is pruned while it is away — dropping the subscription then is exactly
    // what loses the replay.
  };

  scan();
  scanTimer = setInterval(scan, scanIntervalMs);
  scanTimer.unref?.();

  stream.on("close", () => {
    if (scanTimer) clearInterval(scanTimer);
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    unsubscribes.clear();
  });

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
