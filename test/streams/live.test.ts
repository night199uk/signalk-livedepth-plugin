import { expect, test, vi } from "vitest";
import type { Delta, ServerAPI, SubscribeMessage } from "@signalk/server-api";
import { createLiveStream } from "../../src/streams/live.js";
import type { Config } from "../../src/config.js";
import type { BathymetryData } from "../../src/types.js";

const config: Config = {
  path: "belowSurface",
  sounder: { x: 0, y: 0 },
  transducerCorrection: "off",
};

const SELF = "urn:mrn:imo:mmsi:123456789";
const DINGHY = "urn:mrn:signalk:uuid:67029419-1949-4e78-9b4b-b16bc683bc23";
const AIS = "urn:mrn:imo:mmsi:999999999";
const NEAR_OK = "urn:mrn:signalk:uuid:near-ok";
const FAR = "urn:mrn:signalk:uuid:far-off";

const iso = new Date().toISOString();
const positionNode = (lon: number, lat: number) => ({
  value: { longitude: lon, latitude: lat },
  timestamp: iso,
});

// Self has depth; the dinghy has depth; the AIS target has only a position.
const vessels: Record<string, unknown> = {
  [SELF]: {
    uuid: SELF,
    navigation: {
      position: positionNode(1, 50),
      headingTrue: { value: 1, timestamp: iso },
    },
    environment: { depth: { belowSurface: { value: 5.5, timestamp: iso } } },
  },
  [DINGHY]: {
    navigation: { position: positionNode(-1, 51) },
    environment: { depth: { belowSurface: { value: 5.5, timestamp: iso } } },
  },
  [AIS]: {
    navigation: { position: positionNode(2, 52) },
  },
};

function resolve(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      root,
    );
}

type Sub = {
  context: string;
  callback: (delta: Delta) => void;
  active: boolean;
};

function fakeApp(v: Record<string, unknown> = vessels) {
  const subs: Sub[] = [];
  const model = structuredClone(v);
  const root = { vessels: model };
  const app = {
    getSelfPath: (path: string) => resolve(model[SELF], path),
    getPath: (path: string) => resolve(root, path),
    subscriptionmanager: {
      subscribe: (
        command: SubscribeMessage,
        unsubscribes: (() => void)[],
        _onError: (error: unknown) => void,
        callback: (delta: Delta) => void,
      ) => {
        const sub: Sub = {
          context: command.context as string,
          callback,
          active: true,
        };
        subs.push(sub);
        unsubscribes.push(() => {
          sub.active = false;
        });
      },
    },
    debug: () => {},
    error: () => {},
  } as unknown as ServerAPI;
  return { app, subs, model };
}

const depthDelta = (context: string, value: number) =>
  ({
    context,
    updates: [
      {
        timestamp: iso,
        values: [{ path: "environment.depth.belowSurface", value }],
      },
    ],
  }) as unknown as Delta;

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("subscribes to every vessel that publishes depth, and only those", () => {
  const { app, subs } = fakeApp();
  createLiveStream(app, config);
  expect(subs.map((s) => s.context).sort()).toEqual(
    [`vessels.${SELF}`, `vessels.${DINGHY}`].sort(),
  );
});

test("keeps a vessel subscribed when it disappears from the data model", () => {
  vi.useFakeTimers();
  try {
    const { app, subs, model } = fakeApp();
    createLiveStream(app, config);
    const dinghy = () => subs.find((s) => s.context === `vessels.${DINGHY}`);
    expect(dinghy()?.active).toBe(true);

    // The vessel goes offline and the server prunes its context.
    delete model[DINGHY];
    vi.advanceTimersByTime(15000);

    // It stays subscribed, so a replay on reconnect is not missed.
    expect(dinghy()?.active).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("pairs a target vessel's depth with that vessel's own position", async () => {
  const { app, subs } = fakeApp();
  const stream = createLiveStream(app, config);
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  subs
    .find((s) => s.context === `vessels.${DINGHY}`)!
    .callback(depthDelta(`vessels.${DINGHY}`, 7.25));

  await tick();
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    depth: 7.25,
    longitude: -1,
    latitude: 51,
    context: `vessels.${DINGHY}`,
  });
});

test("pairs a sounding with a position carried in the same update", async () => {
  const { app, subs } = fakeApp();
  const stream = createLiveStream(app, config);
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  subs
    .find((s) => s.context === `vessels.${DINGHY}`)!
    .callback({
      context: `vessels.${DINGHY}`,
      updates: [
        {
          timestamp: iso,
          values: [
            {
              path: "navigation.position",
              value: { longitude: -2.5, latitude: 50.25 },
            },
            { path: "environment.depth.belowSurface", value: 6.1 },
          ],
        },
      ],
    } as unknown as Delta);

  await tick();
  expect(out).toHaveLength(1);
  // The position from the stream, not the model's (-1, 51): a replayed
  // (back-dated) sounding must use the position it was recorded at.
  expect(out[0]).toMatchObject({
    depth: 6.1,
    longitude: -2.5,
    latitude: 50.25,
  });
});

test("uses the stream's position for a later depth-only update", async () => {
  const { app, subs } = fakeApp();
  const stream = createLiveStream(app, config);
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  const dinghy = subs.find((s) => s.context === `vessels.${DINGHY}`)!;
  dinghy.callback({
    context: dinghy.context,
    updates: [
      {
        timestamp: iso,
        values: [
          {
            path: "navigation.position",
            value: { longitude: -2.5, latitude: 50.25 },
          },
        ],
      },
    ],
  } as unknown as Delta);
  dinghy.callback(depthDelta(dinghy.context, 6.1));

  await tick();
  // One sounding (the position-only update emitted none) at the stream fix.
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    depth: 6.1,
    longitude: -2.5,
    latitude: 50.25,
  });
});

test("falls back to course over ground when there is no compass", async () => {
  const { app, subs } = fakeApp();
  const stream = createLiveStream(app, config);
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  subs
    .find((s) => s.context === `vessels.${DINGHY}`)!
    .callback({
      context: `vessels.${DINGHY}`,
      updates: [
        {
          timestamp: iso,
          values: [
            {
              path: "navigation.position",
              value: { longitude: -2.5, latitude: 50.25 },
            },
            { path: "navigation.courseOverGroundTrue", value: 2.1 },
            { path: "environment.depth.belowSurface", value: 6.1 },
          ],
        },
      ],
    } as unknown as Delta);

  await tick();
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ depth: 6.1, heading: 2.1 });
});

test("applies the transducer offset only to this vessel", async () => {
  const { app, subs } = fakeApp();
  const stream = createLiveStream(app, config, { forward: 10, starboard: 2 });
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  const dinghy = subs.find((s) => s.context === `vessels.${DINGHY}`)!;
  const self = subs.find((s) => s.context === `vessels.${SELF}`)!;
  dinghy.callback(depthDelta(dinghy.context, 4));
  self.callback(depthDelta(self.context, 4));

  await tick();
  const fromDinghy = out.find((d) => d.context === `vessels.${DINGHY}`)!;
  const fromSelf = out.find((d) => d.context === `vessels.${SELF}`)!;
  // The dinghy's sounding is left at its reported position...
  expect(fromDinghy).toMatchObject({ longitude: -1, latitude: 51 });
  // ...while self's is moved by its transducer offset.
  expect(fromSelf.longitude).not.toBe(1);
});

test("drops a co-located vessel's implausible depth (tender on davits)", async () => {
  const now = new Date().toISOString();
  const at = (lon: number, lat: number) => ({
    value: { longitude: lon, latitude: lat },
    timestamp: now,
  });
  const depthAt = (value: number) => ({ value, timestamp: now });

  const model: Record<string, unknown> = {
    [SELF]: {
      uuid: SELF,
      navigation: { position: at(-78.2543, 9.326) },
      environment: { depth: { belowSurface: depthAt(14.4) } },
    },
    [DINGHY]: {
      navigation: { position: at(-78.254298, 9.325976) }, // ~3 m from self
      environment: { depth: { belowSurface: depthAt(4.5) } },
    },
    [NEAR_OK]: {
      navigation: { position: at(-78.254302, 9.325978) }, // ~3 m, same water
      environment: { depth: { belowSurface: depthAt(14.5) } },
    },
    [FAR]: {
      navigation: { position: at(-78.25, 9.35) }, // kilometres away
      environment: { depth: { belowSurface: depthAt(4.5) } },
    },
  };

  const { app, subs } = fakeApp(model);
  const stream = createLiveStream(app, config);
  const out: BathymetryData[] = [];
  stream.on("data", (data: BathymetryData) => out.push(data));

  const feed = (context: string, value: number) =>
    subs
      .find((s) => s.context === `vessels.${context}`)!
      .callback({
        context: `vessels.${context}`,
        updates: [
          {
            timestamp: now,
            values: [{ path: "environment.depth.belowSurface", value }],
          },
        ],
      } as unknown as Delta);

  feed(DINGHY, 4.5); // beside us, 10 m shallower: not our water -> dropped
  feed(NEAR_OK, 14.5); // beside us, same water -> kept
  feed(FAR, 4.5); // far away -> kept regardless of depth

  await tick();
  expect(out.map((d) => d.context).sort()).toEqual(
    [`vessels.${NEAR_OK}`, `vessels.${FAR}`].sort(),
  );
});
