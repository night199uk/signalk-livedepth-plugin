import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import type { HistoryApi } from "@signalk/server-api/history";
import { getHistoryAPI } from "../src/history.js";

test("waits for a history provider that registers after the plugin starts", async () => {
  const provider = {} as HistoryApi;
  let calls = 0;
  const app = {
    getHistoryApi: () =>
      ++calls < 3
        ? Promise.reject(new Error("No history api provider configured"))
        : Promise.resolve(provider),
    debug: () => {},
  } as unknown as ServerAPI;

  const api = await getHistoryAPI({ app, waitMs: 1_000, pollMs: 1 });
  expect(api).toBe(provider);
  expect(calls).toBe(3);
});

test("gives up when no provider ever registers", async () => {
  let calls = 0;
  const app = {
    getHistoryApi: () => {
      calls++;
      return Promise.reject(new Error("No history api provider configured"));
    },
    debug: () => {},
  } as unknown as ServerAPI;

  // Point the HTTP fallback at a closed port so it fails immediately.
  const api = await getHistoryAPI({
    app,
    waitMs: 0,
    pollMs: 1,
    host: "http://127.0.0.1:1/",
  });
  expect(api).toBeUndefined();
  expect(calls).toBe(1);
});
