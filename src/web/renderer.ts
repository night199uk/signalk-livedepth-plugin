// The LiveDepth background runtime: a headless iframe the host loads while the
// plugin is enabled. It owns the soundings, asks its render Worker for a frame
// on each `overlay.request`, and answers with `overlay.frame`.
//
// Data has two sources, matching the plugin's two modes: the server's History
// API (the vessel's own recent track) or the plugin's gridded bathymetry tiles
// — both reached over same-origin REST, since the runtime is served by the same
// server as the data. The own vessel's live position + depth arrive over the
// bus (`signalk.subscribe`) and extend the tile source in place.

import { connectExtension } from "signalk-plotterext-bus/extension";
import type {
  OverlayRequestEvent,
  OverlayStateEvent,
} from "signalk-plotterext-bus/extension";
import type { DepthSample } from "./shared/live-depth.js";
import { historyValuesQuery, parseDepthSeries } from "./shared/live-depth.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type LiveDepthSettings,
} from "./shared/settings.js";
import type { RenderRequest, RenderWorkerOut } from "./shared/protocol.js";
import {
  createMemoryTileStore,
  createTileAccumulator,
  cellsToSamples,
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
/** How often the history source is refreshed while the layer is visible. */
const POLL_MS = 15000;
/** Most tile fetches a single view may need before the layer draws nothing. */
const MAX_TILE_FETCHES = 24;
/** How long live soundings are batched before folding into the client store. */
const LIVE_FLUSH_MS = 2000;
/** Depth path when the plugin advertises none. */
const DEFAULT_DEPTH_PATH = "environment.depth.belowTransducer";

const client = await connectExtension();
const worker = new Worker(new URL("./render-worker.js", import.meta.url), {
  type: "module",
});

let settings: LiveDepthSettings = { ...DEFAULT_SETTINGS };
let transducer: TransducerOffset | null = null;
let depthPath = DEFAULT_DEPTH_PATH;

let samples: DepthSample[] = [];
let lastReq: RenderRequest | null = null;
let busy = false;
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
let timer: ReturnType<typeof setTimeout> | undefined;

// Client-side mirror of the tile store, extended from the live stream.
let lastZoom = 0;
let clientStore = createMemoryTileStore();
let clientAccumulator = createTileAccumulator(clientStore);
let liveDirty = false;
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
  } catch {
    // No plugin meta: the history source still works, uncorrected.
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

async function fetchHistory(): Promise<void> {
  const windowMs = settings.historyWindowHours * 3600000;
  const to = Date.now();
  const query = historyValuesQuery({
    depthPath,
    from: to - windowMs,
    to,
    resolution: Number(settings.historyResolutionS.toPrecision(3)),
  });
  const res = await fetch(`/signalk/v2/api/history/values?${query}`, {
    credentials: "same-origin",
  });
  if (!res.ok) return;
  const rows = parseDepthSeries(await res.json(), depthPath);
  const out: DepthSample[] = [];
  for (const row of rows) {
    if (!row.position) continue;
    const { lon, lat } = correct(row.position[0], row.position[1], row.heading);
    out.push({ lon, lat, depth: row.depth });
  }
  samples = out;
  publish();
}

async function fetchTiles(req: RenderRequest): Promise<void> {
  const cellMetres = Math.max(req.resolution, 0.01);
  let zoom = zoomForCellSize(cellMetres, MIN_ZOOM, BASE_ZOOM);
  while (zoom > MIN_ZOOM) {
    const { xs, ys } = tileRangeForBbox(req.bounds, zoom);
    if (xs.length * ys.length <= MAX_TILE_FETCHES) break;
    zoom--;
  }
  lastZoom = zoom;
  const { xs, ys } = tileRangeForBbox(req.bounds, zoom);
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
  // Fold in the own vessel's live extension at the same level.
  for (const x of xs) {
    for (const y of ys) {
      const cells = clientStore.read(lastZoom, x, y);
      if (cells && cells.size) {
        out.push(...cellsToSamples(lastZoom, x, y, cells));
      }
    }
  }
  samples = out;
  publish();
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
}

async function refresh(): Promise<void> {
  if (!settings.enabled) return;
  if (settings.source === "history") {
    await fetchHistory();
  } else if (lastReq) {
    await fetchTiles(lastReq);
  }
}

function publish(): void {
  worker.postMessage({ type: "samples", samples });
  dirty = true;
  // A live frame for the last request, so the layer updates without a new one.
  if (lastReq) draw(true);
}

// ******** live extension (tiles source) ********

let liveUnsub: (() => Promise<void>) | undefined;

function startLive(): void {
  if (settings.source !== "tiles" || liveUnsub) return;
  void client.signalk
    .subscribe(
      ["navigation.position", depthPath, "navigation.headingTrue"],
      (ev) => {
        if (ev.path === "navigation.position" && Array.isArray(ev.value)) {
          livePosition = ev.value as [number, number];
        } else if (ev.path === depthPath && typeof ev.value === "number") {
          liveDepth = ev.value;
        } else if (
          ev.path === "navigation.headingTrue" &&
          typeof ev.value === "number"
        ) {
          liveHeading = ev.value;
        }
        sampleLive();
      },
    )
    .then((un) => {
      liveUnsub = un;
    })
    .catch(() => {});
  clearInterval(liveFlushTimer);
  liveFlushTimer = setInterval(flushLive, LIVE_FLUSH_MS);
}

function stopLive(): void {
  clearInterval(liveFlushTimer);
  liveFlushTimer = undefined;
  void liveUnsub?.();
  liveUnsub = undefined;
}

let livePosition: [number, number] | null = null;
let liveDepth: number | null = null;
let liveHeading: number | undefined;

function sampleLive(): void {
  if (!livePosition || liveDepth === null) return;
  const { lon, lat } = correct(livePosition[0], livePosition[1], liveHeading);
  clientAccumulator.add({ lon, lat, depth: liveDepth });
  liveDirty = true;
}

function flushLive(): void {
  if (!liveDirty) return;
  liveDirty = false;
  clientAccumulator.flush();
  if (settings.source === "tiles" && lastReq) void fetchTiles(lastReq);
}

// ******** frame cycle ********

function draw(live = false): void {
  if (busy || !lastReq || !settings.enabled) return;
  if (live && Date.now() - lastLiveAt < liveInterval) return;
  busy = true;
  rendering = lastReq;
  renderingLive = live;
  dirty = false;
  worker.postMessage({ type: "render", req: rendering });
}

worker.onmessage = (e: MessageEvent<RenderWorkerOut>) => {
  const msg = e.data;
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
  draw();
});

await client.subscribe(["overlay.state"], (_name, payload) => {
  const state = payload as OverlayStateEvent;
  if (!state.visible || state.suspended) {
    worker.postMessage({ type: "release" });
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
startLive();
setInterval(() => {
  if (settings.enabled && settings.source === "history") schedule();
}, POLL_MS);
