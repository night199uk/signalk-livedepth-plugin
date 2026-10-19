import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The providing plugin's id; also the plotterExtensions resource key. */
export const PLUGIN_ID = "signalk-livedepth-plugin";
/** Top-level, non-admin route the extension's pages and data are served from. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

/** The plotterExtensions manifest (see docs/api/plotter-extensions-api.md). */
export interface PlotterExtManifest {
  name: string;
  description: string;
  version: string;
  apiVersion: string;
  requires: string[];
  optional: string[];
  buttons: unknown[];
  panels: unknown[];
  background: unknown[];
  overlays: unknown[];
}

/** The plugin's own version, read from its package.json. */
function pluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Build the extension manifest offered to a host chartplotter.
 *
 * One `image` overlay, drawn by a headless background runtime, placed above
 * the charts and below the vessel/resources. A `mapToolbar` button opens the
 * settings panel, which shares state with the runtime over the bus. */
export function buildManifest(version = pluginVersion()): PlotterExtManifest {
  return {
    name: "LiveDepth",
    description:
      "Draw your recorded depth as a live depth map on the chart, shaded with depth contours.",
    version,
    apiVersion: "1",
    requires: ["background.iframe", "overlays.image", "signalk.stream"],
    optional: ["buttons", "panels.iframe", "units", "map", "nightMode"],
    buttons: [
      {
        id: "open-livedepth-settings",
        title: "LiveDepth",
        slot: "mapToolbar",
        icon: "water",
        action: { type: "togglePanel", panel: "livedepth-settings" },
      },
    ],
    panels: [
      {
        id: "livedepth-settings",
        title: "LiveDepth",
        type: "iframe",
        url: `${ASSET_BASE}/config.html`,
        lifecycle: "keepAlive",
      },
    ],
    background: [
      {
        id: "renderer",
        type: "iframe",
        url: `${ASSET_BASE}/renderer.html`,
      },
    ],
    overlays: [
      {
        id: "depth",
        title: "Live depth",
        type: "image",
        runtime: "renderer",
        band: "aboveCharts",
        visible: true,
        opacity: 0.85,
        minZoom: 4,
        // The Chart list's "Layer settings" button opens this panel, so the
        // layer's settings sit with the layer, not only behind the toolbar
        // button.
        configPanel: "livedepth-settings",
        // No `preferredPixelRatio`: the host then uses the display's own device
        // pixel ratio, which is native and sharp. Asking for 2 oversampled on a
        // 1×/1.33× display, and that cost is paid per frame in the transfer and
        // composite — the render-quality setting scales further if needed.
      },
    ],
  };
}
