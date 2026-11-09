// The LiveDepth background runtime: a headless iframe the host loads while the
// plugin is enabled. It owns the soundings, asks its render Worker for a frame
// on each `overlay.request`, and answers with `overlay.frame`.
//
// Data comes from the plugin's gridded bathymetry tiles, reached over
// same-origin REST since the runtime is served by the same server. The own
// vessel's live position + depth arrive over the bus (`signalk.subscribe`) and
// extend the grid in place. When the plugin stores depths relative to a tide
// datum, the raw live depths are not folded in; the corrected tiles are
// re-fetched instead.

import { connectExtension } from "signalk-plotterext-bus/extension";
import type {
  OverlayRequestEvent,
  OverlayStateEvent,
} from "signalk-plotterext-bus/extension";
import { tileFetchRequired, type DepthSample } from "./shared/live-depth.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type LiveDepthSettings,
} from "./shared/settings.js";
import type { RenderRequest, RenderWorkerOut } from "./shared/protocol.js";
import {
  correctToTransducer,
  decodeTileSamples,
  tileRangeForBbox,
  zoomForCellSize,
  BASE_ZOOM,
  MIN_ZOOM,
  type TileMeta,
  type TransducerOffset,
} from "../tiles/core/index.js";

const PLUGIN_ID = "signalk-livedepth-plugin";
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;
const BATHY_BASE = `${ASSET_BASE}/bathymetry`;

/** Settle time before a moved view or a changed window is fetched. */
const DEBOUNCE_MS = 400;
/** Each side of the tile fetch box is this much wider than the view, so a pan
 * or a follow step inside the padding reuses the fetched tiles and the built
 * depth field instead of re-fetching and rebuilding. 0.1 = 1.2x the view, matching the host's OVERLAY_MARGIN. */
const TILE_PAD = 0.1;
const MAX_LAT = 85;

/** The padded tile box and zoom that produced the current base samples. */
let fetchedBounds: [number, number, number, number] | null = null;
let fetchedZoom: number | null = null;

/** `bounds` with `pad` of its width and height added on each side. */
function padBounds(
  bounds: readonly number[],
  pad: number,
): [number, number, number, number] {
  const [west, south, east, north] = bounds;
  const dx = (east - west) * pad;
  const dy = (north - south) * pad;
  return [
    west - dx,
    Math.max(-MAX_LAT, south - dy),
    east + dx,
    Math.min(MAX_LAT, north + dy),
  ];
}

/** Most tile fetches a single view may need before the layer draws nothing. */
const MAX_TILE_FETCHES = 24;
/** How long live soundings are batched before folding into the client store.
 * Kept short so the surface fills in under the bow rather than a couple of
 * seconds behind it. */
const LIVE_FLUSH_MS = 300;
/** Depth path when the plugin advertises none. */
const DEFAULT_DEPTH_PATH = "environment.depth.belowTransducer";
/** How often to pull the server's tide-corrected tiles while soundings arrive.
 * The client cannot correct its own live depth, so it renders the corrected
 * server grid instead of folding raw soundings onto it. */
const LIVE_TILE_REFRESH_MS = 10_000;

const client = await connectExtension();
// Version the worker URL so a plugin update (a new deploy) is never served
// from the browser's cache of the previous worker.
const worker = new Worker(
  new URL(`./render-worker.js?v=${__VERSION__}`, import.meta.url),
  { type: "module" },
);

let settings: LiveDepthSettings = { ...DEFAULT_SETTINGS };
let transducer: TransducerOffset | null = null;
let depthPath = DEFAULT_DEPTH_PATH;
/** The vessel's dimensions and whether to draw the debug footprint, from the
 * plugin's meta. */
let vessel: { loa?: number; beam?: number } = {};
let showFootprint = false;
/** Whether the server stores depths relative to a tide datum. If so, the
 * client must not fold its own raw soundings onto the corrected grid. */
let tideCorrected = false;
/** A live depth has arrived since the last corrected-tile refresh. */
let liveTilesDirty = false;
let liveTilesTimer: ReturnType<typeof setInterval> | undefined;
/** Where the vessel was when the corrected tiles were last pulled, so an
 * anchored boat does not re-fetch the same unchanged cells every tick. */
let tilesRefreshAt: [number, number] | null = null;
/** How far the vessel must move before corrected tiles are worth re-pulling. */
const TILE_REFRESH_METRES = 10;

/** The server-derived grid soundings; the worker folds the live
 * own-vessel soundings onto these. */
let baseSamples: DepthSample[] = [];
let lastReq: RenderRequest | null = null;
let busy = false;
/** Reset the frame cycle if the worker stops answering (a dead or evicted
 * worker would otherwise leave `busy` set and freeze the overlay). */
let busyTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
/** The request currently being rendered. Its frame carries this request's own
 * id and extent, even if a newer one arrives mid-render, so the host refuses a
 * stale frame as `superseded` rather than reading it as a size mismatch. */
let rendering: RenderRequest | null = null;
/** Whether the frame being rendered is a live (data-driven) one, sent without a
 * request id and paced by the host's `liveInterval`. */
let renderingLive = false;
/** The host's least interval between two live frames, in ms. */
let liveInterval = 200;
/** When the last live frame was sent, to pace the next. */
let lastLiveAt = 0;
/** The worker's last perf readout, for the frame-rate log. */
let perfScale = 0;
let perfFrameMs = 0;
let framesSeen = 0;
let framesSince = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;
/** True while the tab is hidden: no frames, no fetches, no timers. */
let paused = false;

// Own-vessel soundings buffered since the last flush, sent to the worker to be
// folded into the field.
let pendingLive: DepthSample[] = [];
let liveFlushTimer: ReturnType<typeof setInterval> | undefined;

// ******** settings ********

async function loadSettings(): Promise<void> {
  try {
    const values = await client.state.get();
    settings = mergeSettings(values as Record<string, unknown>);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  worker.postMessage({ type: "settings", settings });
  startLive();
  schedule();
}

// ******** data ********

async function loadMeta(): Promise<void> {
  try {
    const res = await fetch(`${BATHY_BASE}/meta`, {
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const meta = (await res.json()) as TileMeta;
    transducer = meta.transducer ?? null;
    if (meta.depthPath) depthPath = meta.depthPath;
    vessel = meta.vessel ?? {};
    showFootprint = meta.debug?.vesselFootprint === true;
    const wasCorrected = tideCorrected;
    tideCorrected = meta.tide !== undefined && meta.tide.mode !== "off";
    // The live wiring depends on this: restart it if the datum appeared after a
    // state event already started it.
    if (wasCorrected !== tideCorrected && liveUnsub) {
      stopLive();
      startLive();
    }
    publishVessel();
  } catch {
    // No plugin meta: soundings are drawn uncorrected.
  }
}

/** Shift a sounding from the reported position to the transducer, when the
 * plugin's meta told us to correct. */
function correct(
  lon: number,
  lat: number,
  heading: number | undefined,
): { lon: number; lat: number } {
  return transducer
    ? correctToTransducer({ lon, lat }, heading, transducer)
    : { lon, lat };
}

/** Ask the host for the user's preferred depth unit, for the labels. */
async function loadUnits(): Promise<void> {
  try {
    const res = (await client.call("units.get")) as {
      units?: { depth?: string };
    };
    if (res?.units?.depth) {
      worker.postMessage({ type: "units", depth: res.units.depth });
    }
  } catch {
    // No units capability: the labels stay in metres.
  }
}

async function fetchTiles(req: RenderRequest): Promise<void> {
  const fetchBounds = padBounds(req.bounds, TILE_PAD);
  const cellMetres = Math.max(req.resolution, 0.01);
  let zoom = zoomForCellSize(cellMetres, MIN_ZOOM, BASE_ZOOM);
  while (zoom > MIN_ZOOM) {
    const { xs, ys } = tileRangeForBbox(fetchBounds, zoom);
    if (xs.length * ys.length <= MAX_TILE_FETCHES) break;
    zoom--;
  }
  // Reuse the cached tiles only when the view fits inside them at the same or
  // a finer level. A contained view after zooming back in still needs a finer
  // fetch, or the layer just scales the coarse zoomed-out tiles.
  if (
    !tileFetchRequired(
      fetchedBounds && fetchedZoom !== null
        ? { bounds: fetchedBounds, zoom: fetchedZoom }
        : null,
      req.bounds,
      zoom,
    )
  ) {
    return;
  }
  const { xs, ys } = tileRangeForBbox(fetchBounds, zoom);
  const out: DepthSample[] = [];
  await Promise.all(
    xs.flatMap((x) =>
      ys.map(async (y) => {
        try {
          const res = await fetch(`${BATHY_BASE}/tiles/${zoom}/${x}/${y}`, {
            credentials: "same-origin",
          });
          if (!res.ok) return;
          const bytes = new Uint8Array(await res.arrayBuffer());
          out.push(...decodeTileSamples(zoom, x, y, bytes));
        } catch {
          // A missing tile is simply no data there.
        }
      }),
    ),
  );
  baseSamples = out;
  fetchedBounds = fetchBounds;
  fetchedZoom = zoom;
  publishBase();
}

function schedule(): void {
  if (paused) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
}

async function refresh(): Promise<void> {
  if (paused || !settings.enabled) return;
  if (lastReq) await fetchTiles(lastReq);
}

/** Hand the worker the server-derived soundings; it rebuilds the field around
 * them. */
function publishBase(): void {
  worker.postMessage({ type: "base", samples: baseSamples });
  dirty = true;
  // A live frame for the last request, so the layer updates without a new one.
  if (lastReq) draw(true);
}

// ******** live extension ********

let liveUnsub: (() => Promise<void>) | undefined;

function startLive(): void {
  if (liveUnsub) return;
  void client.signalk
    .subscribe(
      ["navigation.position", depthPath, "navigation.headingTrue"],
      (ev) => {
        if (ev.path === "navigation.position") {
          // The host relays the path's raw Signal K value, which is an object
          // (`{ latitude, longitude }`); a host that normalises positions
          // sends an array instead. Accept either, so a live sounding is never
          // silently dropped over the shape.
          const p = ev.value as
            | [number, number]
            | { longitude?: number; latitude?: number }
            | null
            | undefined;
          if (Array.isArray(p)) {
            livePosition = [p[0], p[1]];
          } else if (
            typeof p?.longitude === "number" &&
            typeof p?.latitude === "number"
          ) {
            livePosition = [p.longitude, p.latitude];
          }
        } else if (ev.path === depthPath && typeof ev.value === "number") {
          liveDepth = ev.value;
          if (tideCorrected) liveTilesDirty = true;
        } else if (
          ev.path === "navigation.headingTrue" &&
          typeof ev.value === "number"
        ) {
          liveHeading = ev.value;
        }
        publishVessel();
        sampleLive();
      },
    )
    .then((un) => {
      liveUnsub = un;
    })
    .catch(() => {});
  clearInterval(liveFlushTimer);
  liveFlushTimer = setInterval(flushLive, LIVE_FLUSH_MS);
  clearInterval(liveTilesTimer);
  liveTilesTimer = tideCorrected
    ? setInterval(refreshTiles, LIVE_TILE_REFRESH_MS)
    : undefined;
}

function stopLive(): void {
  clearInterval(liveFlushTimer);
  liveFlushTimer = undefined;
  clearInterval(liveTilesTimer);
  liveTilesTimer = undefined;
  void liveUnsub?.();
  liveUnsub = undefined;
}

/** Re-pull the served tiles so tide-corrected soundings reach the layer. */
function refreshTiles(): void {
  if (paused || !settings.enabled || !lastReq || !liveTilesDirty) return;
  // At anchor the corrected cells barely change; wait until the vessel has
  // moved far enough to reach new ones. The dirty flag stays set.
  if (
    livePosition &&
    tilesRefreshAt &&
    !movedMetres(livePosition, tilesRefreshAt, TILE_REFRESH_METRES)
  ) {
    return;
  }
  liveTilesDirty = false;
  tilesRefreshAt = livePosition ? [...livePosition] : null;
  fetchedBounds = null;
  fetchedZoom = null;
  void refresh();
}

/** Whether two `[lon, lat]` points are at least `metres` apart (small-distance
 * approximation, ample for a refresh threshold). */
function movedMetres(
  a: [number, number],
  b: [number, number],
  metres: number,
): boolean {
  const mPerDegLat = 111_320;
  const mPerDegLon =
    mPerDegLat * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (a[0] - b[0]) * mPerDegLon;
  const dy = (a[1] - b[1]) * mPerDegLat;
  return Math.hypot(dx, dy) >= metres;
}

/** Stop all rendering work while the tab is hidden. A backgrounded tab is
 * throttled but still wakes for our timers and can still be asked to render;
 * parking everything keeps a hidden Freeboard close to idle and avoids drawing
 * into a WebGL context the browser may evict. */
function pauseRenderer(): void {
  if (paused) return;
  paused = true;
  clearTimeout(timer);
  timer = undefined;
  clearTimeout(busyTimer);
  busyTimer = undefined;
  busy = false;
  rendering = null;
  if (liveFlushTimer) {
    clearInterval(liveFlushTimer);
    liveFlushTimer = undefined;
  }
  clearInterval(liveTilesTimer);
  liveTilesTimer = undefined;
}

function resumeRenderer(): void {
  if (!paused) return;
  paused = false;
  if (liveUnsub) {
    liveFlushTimer = setInterval(flushLive, LIVE_FLUSH_MS);
    if (tideCorrected) {
      liveTilesTimer = setInterval(refreshTiles, LIVE_TILE_REFRESH_MS);
    }
  }
  schedule();
}

let livePosition: [number, number] | null = null;
let liveDepth: number | null = null;
let liveHeading: number | undefined;

/** Tell the worker the vessel's live position and heading, for the debug
 * footprint overlay. A no-op unless the plugin's debug flag is on. */
function publishVessel(): void {
  if (!showFootprint) return;
  worker.postMessage({
    type: "vessel",
    position: livePosition,
    heading: liveHeading,
    loa: vessel.loa,
    beam: vessel.beam,
  });
  dirty = true;
  if (lastReq) draw(true);
}

function sampleLive(): void {
  // Corrected grids must not receive this vessel's raw depth: the server tiles
  // already carry the tide-corrected soundings.
  if (tideCorrected || !livePosition || liveDepth === null) return;
  const { lon, lat } = correct(livePosition[0], livePosition[1], liveHeading);
  pendingLive.push({ lon, lat, depth: liveDepth });
}

function flushLive(): void {
  if (paused || pendingLive.length === 0) return;
  const live = pendingLive;
  pendingLive = [];
  // Fold the new soundings into the worker's field. No tile re-fetch, and the
  // worker patches only the cells they reach, so a flush is cheap.
  worker.postMessage({ type: "live", samples: live });
  dirty = true;
  if (lastReq) draw(true);
}

// ******** frame cycle ********

function draw(live = false): void {
  if (paused || busy || !lastReq || !settings.enabled) return;
  if (live && Date.now() - lastLiveAt < liveInterval) return;
  busy = true;
  rendering = lastReq;
  renderingLive = live;
  dirty = false;
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => {
    if (!busy) return;
    console.warn("[LiveDepth] render worker did not answer; retrying");
    busy = false;
    rendering = null;
    if (lastReq) draw();
  }, 4000);
  worker.postMessage({ type: "render", req: rendering });
}

worker.onerror = (e) => {
  console.warn("[LiveDepth] render worker error:", e.message);
  clearTimeout(busyTimer);
  busy = false;
  rendering = null;
  dirty = true;
  if (lastReq) draw();
};

worker.onmessage = (e: MessageEvent<RenderWorkerOut>) => {
  const msg = e.data;
  if (msg.type === "perf") {
    perfScale = msg.scale;
    perfFrameMs = msg.frameMs;
    return;
  }
  clearTimeout(busyTimer);
  const req = rendering;
  const live = renderingLive;
  busy = false;
  rendering = null;
  if (msg.type !== "frame" || !req) {
    return;
  }
  if (live) lastLiveAt = Date.now();
  // The host owns the image once it is transferred, and closes a refused one
  // itself, so there is nothing to release here. A live frame carries no
  // request id, so the host paces it against `liveInterval`.
  void client.overlays
    .frame({
      overlayId: req.overlayId,
      requestId: live ? undefined : req.requestId,
      extent: req.extent,
      image: msg.image,
    })
    .catch(() => {});
  // A quick frame-rate readout, with the worker's current render scale, every
  // few seconds — handy when tuning quality or measuring a GPU's headroom.
  framesSeen++;
  const now = Date.now();
  if (now - framesSince >= 5000) {
    const fps = (framesSeen * 1000) / (now - framesSince);
    console.info(
      `[LiveDepth] ${fps.toFixed(1)} frames/s · render scale ${perfScale.toFixed(2)} · worker ${perfFrameMs.toFixed(1)} ms/frame`,
    );
    framesSeen = 0;
    framesSince = now;
  }
  // A newer request arrived, or the data changed, while this frame rendered.
  if (dirty || lastReq !== req) draw(live);
};

// ******** bus wiring ********

await client.subscribe(["overlay.request"], (_name, payload) => {
  const req = payload as OverlayRequestEvent;
  lastReq = req;
  if (typeof req.liveInterval === "number" && req.liveInterval > 0) {
    liveInterval = req.liveInterval;
  }
  // The tiles are view-dependent: a settled pan/zoom needs the tiles covering
  // its own bbox. Without this the layer keeps drawing the tile set fetched for
  // the previous view, which is why panning showed only partial tracks.
  schedule();
  draw();
});

await client.subscribe(["overlay.state"], (_name, payload) => {
  const state = payload as OverlayStateEvent;
  if (!state.visible || state.suspended) {
    worker.postMessage({ type: "release" });
    fetchedBounds = null;
    fetchedZoom = null;
    stopLive();
  } else {
    startLive();
    schedule();
  }
});

await client.subscribe(["state.changed"], () => void loadSettings());

await loadMeta();
await loadSettings();
await loadUnits();

// The iframe's visibility mirrors the top-level tab, so this fires when the
// user switches tabs or backgrounds the browser.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pauseRenderer();
  else resumeRenderer();
});
