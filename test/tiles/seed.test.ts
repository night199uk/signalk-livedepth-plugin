import { expect, test, vi } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import type { HistoryApi, ValuesResponse } from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { Config } from "../../src/config.js";
import {
  BASE_ZOOM,
  MIN_ZOOM,
  correctToTransducer,
  createTileAccumulator,
  lngLatToCell,
} from "signalk-livedepth-tiles";
import { createTileDB, createTileStore } from "../../src/tiles/store.js";
import { SEED_CURSOR_KEY, seedFromHistory } from "../../src/tiles/seed.js";

const app = {
  debug: () => {},
  getSelfPath: () => undefined,
  getPath: () => undefined,
  setPluginStatus: () => {},
  setPluginError: () => {},
} as unknown as ServerAPI;

const config = {
  path: "belowTransducer",
  sounder: { x: 0, y: 0 },
  transducerCorrection: "off",
} as Config;

const depthPath = `environment.depth.${config.path}`;

/** A position and the base-level tile it lands in. */
const position: [number, number] = [0.001, 0.001];
const tile = lngLatToCell(position[0], position[1], BASE_ZOOM);

function historyReturning(
  rows: [string, [number, number], number][],
): HistoryApi {
  return {
    getValues: vi.fn(async (): Promise<ValuesResponse> => {
      return {
        values: [{ path: "navigation.position" }, { path: depthPath }],
        data: rows.map(([ts, position, depth]) => [ts, position, depth]),
      } as unknown as ValuesResponse;
    }),
    getContexts: vi.fn(async () => ({})),
    getPaths: vi.fn(async () => ({})),
  } as unknown as HistoryApi;
}

test("accumulator keeps the shallowest depth per cell and min-pools ancestors", () => {
  const store = createTileStore(createTileDB(":memory:"));
  const accumulator = createTileAccumulator(store);

  accumulator.add({ lon: 0.001, lat: 0.001, depth: 12 } as never);
  accumulator.add({ lon: 0.001, lat: 0.001, depth: 8 } as never);
  accumulator.flush();

  const cells = store.read(BASE_ZOOM, tile.x, tile.y);
  expect(cells?.size).toBe(1);
  expect([...cells!.values()][0]).toEqual({ depth: 800, count: 2 });

  // The parent pools the same cell one level up.
  const parent = store.read(BASE_ZOOM - 1, tile.x >> 1, tile.y >> 1);
  expect(parent?.size).toBe(1);
  store.close();
});

test("seeding folds history rows into the tiles and records a cursor", async () => {
  const store = createTileStore(createTileDB(":memory:"));
  const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
  const to = from.add({ hours: 12 });
  const history = historyReturning([
    ["2024-01-01T01:00:00Z", [0.001, 0.001], 15],
    ["2024-01-01T07:00:00Z", [0.001, 0.001], 9],
  ]);

  const progress = await seedFromHistory({
    app,
    store,
    config,
    from,
    to,
    chunkHours: 6,
    history,
  });

  // Two 6-hour chunks, two rows each.
  expect(progress.chunks).toBe(2);
  expect(progress.points).toBe(4);
  expect(progress.done).toBe(true);
  expect(history.getValues).toHaveBeenCalledTimes(2);

  const cells = store.read(BASE_ZOOM, tile.x, tile.y);
  expect([...cells!.values()][0].depth).toBe(900);
  // the single bottom-up pass built the pyramid down to the coarsest level
  expect(store.listTiles(MIN_ZOOM).length).toBeGreaterThan(0);
  expect(store.getMeta(SEED_CURSOR_KEY)).toBe(to.toString());
  store.close();
});

test("a re-run resumes from the cursor instead of repeating", async () => {
  const store = createTileStore(createTileDB(":memory:"));
  const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
  const to = from.add({ hours: 6 });
  const history = historyReturning([
    ["2024-01-01T01:00:00Z", [0.001, 0.001], 15],
  ]);

  await seedFromHistory({ app, store, config, from, to, history });
  expect(store.getMeta(SEED_CURSOR_KEY)).toBe(to.toString());

  const again = await seedFromHistory({ app, store, config, to, history });
  expect(again.chunks).toBe(0);
  expect(history.getValues).toHaveBeenCalledTimes(1);
  store.close();
});

test("a failing chunk is skipped and the seed continues", async () => {
  const store = createTileStore(createTileDB(":memory:"));
  const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
  const to = from.add({ hours: 12 });
  const history = {
    getValues: vi
      .fn()
      .mockRejectedValueOnce(new Error("no data"))
      .mockResolvedValue({
        values: [{ path: "navigation.position" }, { path: depthPath }],
        data: [["2024-01-01T07:00:00Z", [0.001, 0.001], 9]],
      }),
    getContexts: vi.fn(async () => ({})),
    getPaths: vi.fn(async () => ({})),
  } as unknown as HistoryApi;

  const progress = await seedFromHistory({
    app,
    store,
    config,
    from,
    to,
    chunkHours: 6,
    history,
  });

  expect(progress.chunksFailed).toBe(1);
  expect(progress.points).toBe(1);
  expect(store.read(BASE_ZOOM, tile.x, tile.y)?.size).toBe(1);
  store.close();
});

test("shifts soundings to the transducer when an offset is given", async () => {
  const store = createTileStore(createTileDB(":memory:"));
  const from = Temporal.Instant.from("2024-01-01T00:00:00Z");
  const to = from.add({ hours: 6 });
  const history = {
    getValues: vi.fn(
      async (): Promise<ValuesResponse> =>
        ({
          values: [
            { path: "navigation.position" },
            { path: depthPath },
            { path: "navigation.headingTrue" },
          ],
          data: [["2024-01-01T01:00:00Z", [0, 0], 10, 0]],
        }) as unknown as ValuesResponse,
    ),
    getContexts: vi.fn(async () => ({})),
    getPaths: vi.fn(async () => ({})),
  } as unknown as HistoryApi;

  await seedFromHistory({
    app,
    store,
    config,
    from,
    to,
    offset: { forward: 100, starboard: 0 },
    history,
  });

  // heading 0 = north, forward 100 m: the sounding lands north of (0, 0), in a
  // different tile, not at the recorded point.
  const corrected = correctToTransducer({ lon: 0, lat: 0 }, 0, {
    forward: 100,
    starboard: 0,
  });
  const cell = lngLatToCell(corrected.lon, corrected.lat, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, cell.x, cell.y)?.size).toBe(1);
  const original = lngLatToCell(0, 0, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, original.x, original.y)).toBeUndefined();
  store.close();
});
