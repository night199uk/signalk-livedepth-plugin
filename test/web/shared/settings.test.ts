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

  it("migrates state saved with the History API source", () => {
    // Older versions offered the History API as a depth source. That option is
    // gone, so its keys must be dropped while the rest of the state survives.
    const migrated = mergeSettings({
      enabled: true,
      source: "history",
      historyWindowHours: 6,
      historyResolutionS: 0.5,
      shadeLimitMetres: 20,
    });
    expect(migrated).not.toHaveProperty("source");
    expect(migrated).not.toHaveProperty("historyWindowHours");
    expect(migrated).not.toHaveProperty("historyResolutionS");
    expect(migrated.shadeLimitMetres).toBe(20);
  });
});
