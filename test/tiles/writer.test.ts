import { expect, test, vi } from "vitest";
import { createTileDB, createTileStore } from "../../src/tiles/store.js";
import { createTileWriter } from "../../src/tiles/writer.js";

test("destroying the writer stops its flush timer", () => {
  vi.useFakeTimers();
  const store = createTileStore(createTileDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100 });
  writer.write({ longitude: 0, latitude: 0, depth: 5 } as never, () => {});

  writer.destroy();
  store.close();

  // The collector destroys writers on stop without ending them; a surviving
  // timer would flush into the closed store and throw from an uncaught callback.
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  vi.useRealTimers();
});

test("ending the writer flushes pending soundings", async () => {
  const store = createTileStore(createTileDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100000 });
  writer.write({ longitude: 0, latitude: 0, depth: 5 } as never, () => {});
  await new Promise<void>((resolve) => writer.end(() => resolve()));

  expect(store.read(20, 524288, 524288)?.size).toBe(1);
  store.close();
});

test("a locked flush is retried on the next tick", () => {
  vi.useFakeTimers();
  const store = createTileStore(createTileDB(":memory:"));
  vi.spyOn(store, "transaction").mockImplementationOnce(() => {
    throw new Error("database is locked");
  });
  const onError = vi.fn();
  const writer = createTileWriter(store, {
    flushIntervalMs: 100,
    onError,
  });
  writer.write({ longitude: 0, latitude: 0, depth: 5 } as never, () => {});

  vi.advanceTimersByTime(100);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(store.read(20, 524288, 524288)).toBeUndefined();

  vi.advanceTimersByTime(100);
  expect(store.read(20, 524288, 524288)?.size).toBe(1);

  writer.destroy();
  store.close();
  vi.useRealTimers();
});
