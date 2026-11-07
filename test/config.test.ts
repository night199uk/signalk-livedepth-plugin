import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { schema } from "../src/config.js";

function appReturning(value: unknown): ServerAPI {
  return { getSelfPath: () => value } as unknown as ServerAPI;
}

test("the schema survives a JSON round trip, with no undefined defaults", () => {
  // The server stores the schema as JSON, so a `default: undefined` is silently
  // dropped — which the shared plugin CI flags as data loss. `toStrictEqual`
  // distinguishes a key present with `undefined` from an absent one.
  const s = schema(appReturning(undefined));
  expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
});

test("defaults are attached when the server has the values", () => {
  const s = schema(appReturning(3.2)) as unknown as {
    properties: {
      path: { default?: string };
      sounder: {
        properties: { x: { default?: number }; y: { default?: number } };
      };
    };
  };
  expect(s.properties.path.default).toBe("belowSurface");
  expect(s.properties.sounder.properties.y.default).toBe(3.2);
  expect(s.properties.sounder.properties.x.default).toBe(3.2);
});

test("the depth options are the standard Signal K depth datums", () => {
  const s = schema(appReturning(undefined)) as unknown as {
    properties: { path: { enum: string[]; enumNames: string[] } };
  };
  expect(s.properties.path.enum).toEqual([
    "belowSurface",
    "belowTransducer",
    "belowKeel",
  ]);
  expect(s.properties.path.enumNames).toHaveLength(
    s.properties.path.enum.length,
  );
});

test("the tide settings offer a switch and the fixed datums", () => {
  const s = schema(appReturning(undefined)) as unknown as {
    properties: {
      tide: {
        properties: {
          enabled: { default?: boolean };
          datum: { enum: string[]; enumNames: string[]; default?: string };
        };
      };
    };
  };
  const tide = s.properties.tide.properties;
  expect(tide.enabled.default).toBe(false);
  expect(tide.datum.enum).toEqual(["chart", "LAT", "MLLW"]);
  expect(tide.datum.enumNames).toHaveLength(tide.datum.enum.length);
  expect(tide.datum.default).toBe("LAT");
});
