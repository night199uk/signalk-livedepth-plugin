import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  QUALITY_SCALE,
  mergeSettings,
} from "../../../src/web/shared/settings.js";

describe("settings", () => {
  it("defaults to auto quality", () => {
    expect(DEFAULT_SETTINGS.quality).toBe("auto");
  });

  it("keeps a known quality and rejects an unknown one", () => {
    expect(mergeSettings({ quality: "low" }).quality).toBe("low");
    expect(mergeSettings({ quality: "ultra" }).quality).toBe("auto");
  });

  it("pins a render scale for each fixed quality", () => {
    expect(QUALITY_SCALE.high).toBe(1);
    expect(QUALITY_SCALE.balanced).toBeGreaterThan(QUALITY_SCALE.low);
  });
});
