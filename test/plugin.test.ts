import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { readLengthOverall } from "../src/plugin.js";

function appReturning(node: unknown): ServerAPI {
  return { getSelfPath: () => node } as unknown as ServerAPI;
}

test("reads length overall from the compound design.length node", () => {
  // The server exposes design.length as { value: { overall, hull, waterline } };
  // there is no `design.length.overall` leaf for getSelfPath to resolve.
  expect(readLengthOverall(appReturning({ value: { overall: 13.97 } }))).toBe(
    13.97,
  );
});

test("accepts a bare number or a numeric value node", () => {
  expect(readLengthOverall(appReturning(13.97))).toBe(13.97);
  expect(readLengthOverall(appReturning({ value: 13.97 }))).toBe(13.97);
});

test("undefined when the length is absent or non-positive", () => {
  expect(readLengthOverall(appReturning(undefined))).toBeUndefined();
  expect(
    readLengthOverall(appReturning({ value: { overall: 0 } })),
  ).toBeUndefined();
  expect(
    readLengthOverall(appReturning({ value: { overall: -3 } })),
  ).toBeUndefined();
});
