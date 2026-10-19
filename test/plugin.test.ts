import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { readLengthOverall, resolveTransducerOffset } from "../src/plugin.js";
import type { Config } from "../src/config.js";

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

function correctionApp(
  lengthOverall: number | undefined,
  gnssCorrection = "replace",
): ServerAPI {
  return {
    getSelfPath: () =>
      lengthOverall === undefined
        ? undefined
        : { value: { overall: lengthOverall } },
    config: { settings: { gnssCorrection } },
    setPluginError: () => {},
  } as unknown as ServerAPI;
}

const correctionConfig: Config = {
  path: "belowSurface",
  sounder: { x: -1.7, y: 4.16 },
  transducerCorrection: "replace",
};

// Regression: the offset is from the reference (midships) TO the transducer, so
// a transducer forward of midships is a positive shift toward the bow. The sign
// was once inverted, which drew every sounding behind the vessel.
test("a transducer forward of midships is placed ahead of the reference", () => {
  const offset = resolveTransducerOffset(
    correctionApp(13.97),
    correctionConfig,
  );
  // midships is 13.97 / 2 = 6.985 m from the bow, so the transducer at 4.16 m
  // from the bow is 2.825 m forward of it, and 1.7 m to port.
  expect(offset?.forward).toBeCloseTo(2.825, 6);
  expect(offset?.starboard).toBe(-1.7);
});

test("a transducer aft of midships is placed astern of the reference", () => {
  const offset = resolveTransducerOffset(correctionApp(13.97), {
    ...correctionConfig,
    sounder: { x: 0, y: 9 },
  });
  expect(offset?.forward).toBeCloseTo(6.985 - 9, 6);
});

test("no offset when the correction is off or the length is unknown", () => {
  expect(
    resolveTransducerOffset(correctionApp(13.97), {
      ...correctionConfig,
      transducerCorrection: "off",
    }),
  ).toBeUndefined();
  expect(
    resolveTransducerOffset(correctionApp(undefined), correctionConfig),
  ).toBeUndefined();
});
