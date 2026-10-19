/** The message contract between the runtime and its render Worker. Kept in one
 * module so both sides import the same shapes without pulling the other in. */

import type { DepthSample } from "./live-depth.js";
import type { LiveDepthSettings } from "./settings.js";

/** One `overlay.request` (see the Plotter Extensions API). */
export interface RenderRequest {
  overlayId: string;
  requestId: string;
  /** EPSG:3857 `[minX, minY, maxX, maxY]`, may run past ±20037508.34 m. */
  extent: [number, number, number, number];
  /** The same box as `[west, south, east, north]` lon/lat. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
  pixelRatio: number;
  /** Metres per image pixel. */
  resolution: number;
  zoom: number;
  /** Radians clockwise; advisory, for keeping labels upright. */
  rotation: number;
  /** Least time (ms) the host accepts between two live (unrequested) frames. */
  liveInterval?: number;
}

export type RenderWorkerIn =
  /** The server-derived soundings (tiles or history), replacing the whole set;
   * the field is rebuilt around these. */
  | { type: "base"; samples: DepthSample[] }
  /** New own-vessel soundings to fold in, appended to the base; only the cells
   * they reach are refreshed, so a live flush never rebuilds the field. */
  | { type: "live"; samples: DepthSample[] }
  | { type: "settings"; settings: LiveDepthSettings }
  /** The vessel's live position/heading and dimensions, for the debug footprint
   * overlay. Sent when the debug flag is on and any of these change. */
  | {
      type: "vessel";
      position: [number, number] | null;
      heading?: number;
      loa?: number;
      beam?: number;
    }
  /** The user's preferred depth unit (`"m"` or `"foot"`), for the labels. */
  | { type: "units"; depth: string }
  | { type: "render"; req: RenderRequest }
  | { type: "release" };

export type RenderWorkerOut =
  | { type: "frame"; requestId: string; image: ImageBitmap }
  /** Periodic readout of the overlay's render scale and worker cost, so the
   * runtime can log the frame rate and how auto is settling. */
  | { type: "perf"; scale: number; frameMs: number }
  | { type: "error"; message: string };
