/// <reference lib="webworker" />
//
// The render Worker: turns the soundings into one overlay frame.
//
// It is kept off the runtime iframe's main thread — on several engines an
// extension iframe shares the host page's main thread, so a heavy render here
// would stall the whole chart. The runtime sends it the soundings and settings;
// on each `render` request it builds (once per data change) the depth field,
// runs a WebGL2 pass that shades the surface and draws isobaths, composites
// that onto a 2D canvas that adds the shoal/cluster dots and their depth
// labels, and hands the result back as an ImageBitmap.
//
// Geometry: the host asks for a north-up, axis-aligned EPSG:3857 box whose
// pixels are evenly spaced in Mercator metres. The field is built in the same
// space, so a frame is a re-raster of the cached field — panning or zooming
// never changes the surface (and the absolute-depth isobars stay put).

import {
  createDepthFieldBuilder,
  type CellRect,
  type DepthField,
  type DepthFieldBuilder,
} from "./shared/bathymetry.js";
import { DEPTH_FRAG_SRC, DEPTH_VERT_SRC } from "./shared/shaders.js";
import {
  extractContours,
  type ContourSegment,
  type ContourSet,
} from "./shared/contours.js";
import {
  DEFAULT_COVERAGE_MIN_M,
  medianConsecutiveGap,
} from "./shared/bathymetry.js";
import {
  SHADE_CONTOUR_LEVELS,
  depthClusters,
  depthCss,
  latOf,
  lonOf,
  mercX,
  mercY,
  selectShoals,
  shadeColor,
  type DepthCluster,
  type DepthSample,
} from "./shared/live-depth.js";
import { QUALITY_SCALE, type LiveDepthSettings } from "./shared/settings.js";
import type {
  RenderRequest,
  RenderWorkerIn,
  RenderWorkerOut,
} from "./shared/protocol.js";

/** Hard cap on a field dimension; if the cell would exceed it the cells are
 * grown to fit, so the grid always covers the whole data extent. */
const MAX_FIELD_CELLS = 1024;
/** Label size (CSS px): scaled with zoom between a readable floor and a cap. */
const LABEL_FONT_MIN = 12;
const LABEL_FONT_MAX = 20;
/** Smallest on-screen radius (CSS px) at which a group is labelled. */
const LABEL_MIN_RADIUS_PX = 8;

const ORIGIN_SHIFT = Math.PI * 6378137;
const WORLD_WIDTH = 2 * ORIGIN_SHIFT;

let samples: DepthSample[] = [];
/** The server-derived soundings, replaced as a whole on a base update. */
let baseSamples: DepthSample[] = [];
/** The own-vessel soundings folded in since, appended and never rebuilt. */
let liveSamples: DepthSample[] = [];
let settings: LiveDepthSettings | null = null;
let builder: DepthFieldBuilder | null = null;
let fieldDirty = true;
/** The vessel's live position/heading + dimensions, for the debug footprint. */
let vessel: {
  position: [number, number] | null;
  heading?: number;
  loa?: number;
  beam?: number;
} = { position: null };
/** The user's preferred depth unit (`"m"` or `"foot"`), for the labels. */
let depthUnit = "m";

/** Bumped whenever `samples` changes, so the overlay caches below recompute on
 * a data change rather than on every render. */
let samplesVersion = 0;
/** The shoal samples and depth clusters, keyed on their inputs: a frame that
 * only moves the view (or is a live tick with no new soundings) reuses them
 * instead of re-aggregating every sample. */
let shoalCache: { key: string; value: DepthSample[] } | null = null;
let clusterCache: { key: string; value: DepthCluster[] } | null = null;
/** Vector contours for the current field, in world metres. */
let contours: ContourSet = { major: [], minor: [] };
/** The MSAA setting the live GL context was created with. */
let gpuMsaa = true;

/** Budget for one frame's worker work, in ms; `auto` scales the shaded surface
 * to hold it. */
const AUTO_FRAME_BUDGET_MS = 10;
/** Frames between auto adjustments. Adjusting every frame makes the surface
 * hunt (and the map shimmer); a couple of seconds apart lets it settle. */
const AUTO_ADJUST_EVERY = 30;
/** Frames between perf readouts to the runtime. */
const PERF_REPORT_EVERY = 20;
/** The scale `auto` has settled on; stepped occasionally. */
let autoScale = 0.7;
/** Rolling average of the frame cost, for a stable auto decision. */
let frameAvgMs = 0;
/** Frames since the last auto adjustment. */
let framesSinceAdjust = 0;
/** Frames since the last perf readout. */
let perfFrames = 0;

/** The shaded-surface scale for this frame: pinned by the quality setting, or
 * the adaptive value in `auto`. Only the WebGL surface is drawn at this scale;
 * the dots, clusters and labels are always drawn at full resolution, so the
 * map stays readable and keeps every depth measurement. */
function renderScale(): number {
  // Full-resolution renders the surface at the host's requested size, ignoring
  // the quality scale (crowd-depth parity).
  if (settings?.fullResolution) return 1;
  const quality = settings?.quality ?? "auto";
  return quality === "auto" ? autoScale : QUALITY_SCALE[quality];
}

/** A depth in the user's unit: whole feet, or a tenth of a metre. */
function formatDepth(metres: number): string {
  return depthUnit === "foot"
    ? (metres / 0.3048).toFixed(0)
    : metres.toFixed(1);
}

// ******** WebGL ********

let glCanvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let quad: WebGLBuffer | null = null;
let depthTexture: WebGLTexture | null = null;
let lutTexture: WebGLTexture | null = null;
let aPos = 0;
let uDepth: WebGLUniformLocation | null = null;
let uLut: WebGLUniformLocation | null = null;
let uTexel: WebGLUniformLocation | null = null;
let uView: WebGLUniformLocation | null = null;
let uField: WebGLUniformLocation | null = null;
let uShadeLimit: WebGLUniformLocation | null = null;
let uLevels: WebGLUniformLocation | null = null;
let uInterval: WebGLUniformLocation | null = null;
let uLineWidth: WebGLUniformLocation | null = null;
let uIsobars: WebGLUniformLocation | null = null;

function compile(
  ctx: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = ctx.createShader(type);
  if (!shader) return null;
  ctx.shaderSource(shader, src);
  ctx.compileShader(shader);
  if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
    ctx.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebgl(): boolean {
  if (gl) return true;
  glCanvas = new OffscreenCanvas(1, 1);
  const msaa = settings?.msaa ?? true;
  const ctx = glCanvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: msaa,
  }) as WebGL2RenderingContext | null;
  if (!ctx) return false;
  gpuMsaa = msaa;
  const vs = compile(ctx, ctx.VERTEX_SHADER, DEPTH_VERT_SRC);
  const fs = compile(ctx, ctx.FRAGMENT_SHADER, DEPTH_FRAG_SRC);
  const prog = ctx.createProgram();
  if (!vs || !fs || !prog) return false;
  ctx.attachShader(prog, vs);
  ctx.attachShader(prog, fs);
  ctx.linkProgram(prog);
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) return false;

  gl = ctx;
  program = prog;
  aPos = ctx.getAttribLocation(prog, "aPos");
  uDepth = ctx.getUniformLocation(prog, "uDepth");
  uLut = ctx.getUniformLocation(prog, "uLut");
  uTexel = ctx.getUniformLocation(prog, "uTexel");
  uView = ctx.getUniformLocation(prog, "uView");
  uField = ctx.getUniformLocation(prog, "uField");
  uShadeLimit = ctx.getUniformLocation(prog, "uShadeLimit");
  uLevels = ctx.getUniformLocation(prog, "uLevels");
  uInterval = ctx.getUniformLocation(prog, "uInterval");
  uLineWidth = ctx.getUniformLocation(prog, "uLineWidth");
  uIsobars = ctx.getUniformLocation(prog, "uIsobars");

  quad = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, quad);
  ctx.bufferData(
    ctx.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    ctx.STATIC_DRAW,
  );

  depthTexture = ctx.createTexture();
  ctx.bindTexture(ctx.TEXTURE_2D, depthTexture);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);

  lutTexture = ctx.createTexture();
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = shadeColor(i / 255);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  ctx.bindTexture(ctx.TEXTURE_2D, lutTexture);
  ctx.texImage2D(
    ctx.TEXTURE_2D,
    0,
    ctx.RGBA,
    256,
    1,
    0,
    ctx.RGBA,
    ctx.UNSIGNED_BYTE,
    lut,
  );
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);

  return true;
}

/** Release the GL context while the overlay is hidden or suspended. */
function releaseGpu(): void {
  if (gl) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  gl = null;
  program = null;
  quad = null;
  depthTexture = null;
  lutTexture = null;
  glCanvas = null;
}

function uploadField(f: DepthField): void {
  if (!gl || !depthTexture) return;
  // GLSL ES does not require NaN support, so the no-coverage marker the field
  // uses on the CPU (NaN) is uploaded as -1 — a value no real depth can take —
  // and the shader tests `v < 0` for it.
  const gpu = new Float32Array(f.depth.length);
  for (let i = 0; i < f.depth.length; i++) {
    const d = f.depth[i];
    gpu[i] = Number.isNaN(d) ? -1 : d;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    f.width,
    f.height,
    0,
    gl.RED,
    gl.FLOAT,
    gpu,
  );
}

/** Upload only the cells in `rect` (half-open), so folding a live sounding in
 * costs a few rows of texture rather than the whole field. */
function uploadRegion(f: DepthField, [x0, y0, x1, y1]: CellRect): void {
  if (!gl || !depthTexture) return;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const gpu = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * f.width + x0;
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      const d = f.depth[src + x];
      gpu[dst + x] = Number.isNaN(d) ? -1 : d;
    }
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED, gl.FLOAT, gpu);
}

/** Rebuild the field around the current base (a view change or a settings
 * change), then fold the own-vessel soundings back in. This is the only path
 * that pays for a whole-grid rebuild; a live flush just patches cells. */
function rebuildField(): void {
  builder = null;
  samples = [...baseSamples, ...liveSamples];
  // Size the grid off the server data, which covers the view; a live sounding
  // outside it is clipped until the next base refresh rather than growing the
  // grid (and forcing a rebuild) on every flush.
  const source = baseSamples.length ? baseSamples : samples;
  if (source.length === 0 || !settings) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of source) {
    const x = mercX(s.lon);
    const y = mercY(s.lat);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const padX = (maxX - minX) * 0.1 + 1;
  const padY = (maxY - minY) * 0.1 + 1;
  const extent: [number, number, number, number] = [
    minX - padX,
    minY - padY,
    maxX + padX,
    maxY + padY,
  ];
  const extMax = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
  // Tile samples are already gridded, not along-track ordered, so a
  // consecutive-gap estimate is meaningless; the target cell size is the field
  // resolution instead.
  const tiles = settings.source === "tiles";
  const gap = tiles ? 0 : medianConsecutiveGap(source);
  const minCover = tiles ? 0 : DEFAULT_COVERAGE_MIN_M;
  const maxCells = Math.max(
    64,
    Math.round(settings.fieldCells) || MAX_FIELD_CELLS,
  );
  const cell = Math.max(gap, extMax / maxCells, minCover / 8, 0.01);
  const next = createDepthFieldBuilder(extent, {
    cellMetres: cell,
    maxCells,
    // `gap` bridges the along-track gaps, the fill radius widens a sounding
    // into empty water, and a sounding always covers its own cell.
    coverageMetres: Math.max(cell * 1.5, gap * 1.5, settings.fillMetres),
    coverageMinMetres: minCover,
  });
  if (!next) return;
  next.add(baseSamples);
  if (liveSamples.length) next.add(liveSamples);
  builder = next;
  uploadField(next.field);
  // Trace the vector isobars once per (re)build. Live soundings update the
  // surface immediately; the contours catch up on the next base fetch.
  contours = settings.vectorContours
    ? extractContours(
        next.field,
        Math.max(0.01, settings.minorContourMetres),
        Math.max(0.01, settings.contourIntervalMetres),
        Math.max(0, settings.maxDepthMetres),
      )
    : { major: [], minor: [] };
}

/** Fold new own-vessel soundings in, refreshing only the cells they reach. */
function addLive(newSamples: DepthSample[]): void {
  liveSamples.push(...newSamples);
  samples.push(...newSamples);
  samplesVersion++;
  if (!builder) {
    // No field yet (the base has not arrived): rebuild once it does.
    fieldDirty = true;
    return;
  }
  const rect = builder.add(newSamples);
  if (rect) uploadRegion(builder.field, rect);
}

function renderGpu(
  box: readonly [number, number, number, number],
  canvasW: number,
  canvasH: number,
  ratio: number,
): void {
  const f = builder?.field;
  if (!gl || !f || !glCanvas) return;
  if (glCanvas.width !== canvasW || glCanvas.height !== canvasH) {
    glCanvas.width = canvasW;
    glCanvas.height = canvasH;
  }
  gl.viewport(0, 0, canvasW, canvasH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lutTexture);

  const ext = f.extent;
  const fieldCentreX = (ext[0] + ext[2]) / 2;
  const viewCentreX = (box[0] + box[2]) / 2;
  const shift =
    Math.round((fieldCentreX - viewCentreX) / WORLD_WIDTH) * WORLD_WIDTH;
  // Pass field-relative metres to the shader: absolute EPSG:3857 values
  // (~8.6e6) lose about a metre of precision in the shader's float32 maths.
  gl.uniform4f(
    uView,
    box[0] + shift - ext[0],
    box[1] - ext[1],
    box[2] - box[0],
    box[3] - box[1],
  );
  gl.uniform4f(uField, 0, 0, ext[2] - ext[0], ext[3] - ext[1]);
  gl.uniform2f(uTexel, 1 / f.width, 1 / f.height);
  gl.uniform1i(uDepth, 0);
  gl.uniform1i(uLut, 1);
  gl.uniform1f(uShadeLimit, Math.max(0.01, settings?.shadeLimitMetres ?? 10));
  gl.uniform1i(uLevels, SHADE_CONTOUR_LEVELS);
  gl.uniform1f(uInterval, Math.max(0.01, settings?.contourIntervalMetres ?? 1));
  gl.uniform1f(uLineWidth, Math.max(1, ratio));
  gl.uniform1f(uIsobars, settings?.vectorContours ? 0 : 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ******** 2D overlay (dots + labels) ********

/** Draw the vector isobars (traced from the field) on the 2D overlay. */
function drawContours(
  ctx: OffscreenCanvasRenderingContext2D,
  box: readonly [number, number, number, number],
  canvasW: number,
  canvasH: number,
  ratio: number,
): void {
  if (!settings?.vectorContours) return;
  const f = builder?.field;
  if (!f || (contours.major.length === 0 && contours.minor.length === 0)) {
    return;
  }
  const boxW = box[2] - box[0];
  const boxH = box[3] - box[1];
  if (!(boxW > 0) || !(boxH > 0)) return;
  // Match the surface's world copy (see renderGpu).
  const ext = f.extent;
  const shift =
    Math.round(((ext[0] + ext[2]) / 2 - (box[0] + box[2]) / 2) / WORLD_WIDTH) *
    WORLD_WIDTH;
  const px = (x: number) => ((x + shift - box[0]) / boxW) * canvasW;
  const py = (y: number) => ((box[3] - y) / boxH) * canvasH;
  const stroke = (
    segments: ContourSegment[],
    color: string,
    widthPx: number,
  ) => {
    if (segments.length === 0) return;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of segments) {
      ctx.moveTo(px(x0), py(y0));
      ctx.lineTo(px(x1), py(y1));
    }
    ctx.lineWidth = Math.max(0.5, widthPx * ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  // Minor first, so the darker index contours sit on top.
  stroke(
    contours.minor,
    settings.minorContourColor,
    settings.minorContourWidthPx,
  );
  stroke(contours.major, settings.majorContourColor, settings.contourWidthPx);
}

function drawOverlay(
  ctx: OffscreenCanvasRenderingContext2D,
  box: readonly [number, number, number, number],
  canvasW: number,
  canvasH: number,
  resolution: number,
  ratio: number,
  zoom: number,
): void {
  if (!settings) return;
  const boxW = box[2] - box[0];
  const boxH = box[3] - box[1];
  const centreX = (box[0] + box[2]) / 2;
  const toPixel = (lon: number, lat: number): [number, number] => {
    const mx = mercX(lon);
    const my = mercY(lat);
    const x = mx + Math.round((centreX - mx) / WORLD_WIDTH) * WORLD_WIDTH;
    return [((x - box[0]) / boxW) * canvasW, ((box[3] - my) / boxH) * canvasH];
  };
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const dot = (p: [number, number], depth: number) => {
    ctx.beginPath();
    ctx.arc(
      p[0],
      p[1],
      Math.max(1.5, settings!.cellPx * 0.12) * ratio,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = depthCss(depth, settings!.shadeLimitMetres, 0.95);
    ctx.fill();
  };
  const label = (text: string, p: [number, number], fontCss: number) => {
    ctx.font = `${Math.round(fontCss * ratio)}px Roboto, Arial, sans-serif`;
    ctx.lineWidth = Math.max(2, 2 * ratio);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.strokeText(text, p[0], p[1]);
    ctx.fillStyle = "rgba(0,0,0,0.95)";
    ctx.fillText(text, p[0], p[1]);
  };

  drawContours(ctx, box, canvasW, canvasH, ratio);

  // Recomputing these over every sample each frame is the worker's dominant
  // cost; they depend only on the data and the settings (the cluster cell size
  // also on the view resolution), so cache them and rebuild only on a key
  // change — a frame that just moves the view reuses them.
  const shoalKey = `${samplesVersion}:${settings.safetyDepthMetres}`;
  if (!shoalCache || shoalCache.key !== shoalKey) {
    shoalCache = {
      key: shoalKey,
      value: selectShoals(samples, settings.safetyDepthMetres),
    };
  }
  shoalCache.value.forEach((s) => dot(toPixel(s.lon, s.lat), s.depth));

  const cellSize = Math.max(1, settings.cellPx * resolution);
  const clusterKey = `${samplesVersion}:${cellSize}:${settings.mergeTolerance}:${settings.maxDepthMetres}`;
  if (!clusterCache || clusterCache.key !== clusterKey) {
    clusterCache = {
      key: clusterKey,
      value: depthClusters(
        samples,
        cellSize,
        settings.mergeTolerance,
        settings.maxDepthMetres,
      ),
    };
  }
  const clusters = clusterCache.value;
  for (const c of clusters) {
    const p = toPixel(c.lon, c.lat);
    dot(p, c.depth);
    const radiusPx = (c.radiusMetres / resolution) * ratio;
    if (radiusPx >= LABEL_MIN_RADIUS_PX) {
      const fontCss = Math.max(
        LABEL_FONT_MIN,
        Math.min(LABEL_FONT_MAX, (zoom - 8) * 1.5 + LABEL_FONT_MIN),
      );
      label(formatDepth(c.depth), p, fontCss);
    }
  }

  // Debug: the vessel's footprint (LOA × beam) centred on the reported position
  // and rotated to the heading, so where a sounding lands relative to the hull
  // can be seen. Off unless the plugin's debug config turns it on.
  const v = vessel;
  if (v.position && v.heading !== undefined && v.loa && v.beam) {
    const cx = mercX(v.position[0]);
    const cy = mercY(v.position[1]);
    const cos = Math.cos(v.heading);
    const sin = Math.sin(v.heading);
    const halfLength = v.loa / 2;
    const halfBeam = v.beam / 2;
    const corners = (
      [
        [halfLength, halfBeam],
        [halfLength, -halfBeam],
        [-halfLength, -halfBeam],
        [-halfLength, halfBeam],
      ] as const
    ).map(([fwd, stbd]) =>
      toPixel(
        lonOf(cx + fwd * sin + stbd * cos),
        latOf(cy + fwd * cos - stbd * sin),
      ),
    );
    ctx.beginPath();
    corners.forEach(([px, py], i) =>
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py),
    );
    ctx.closePath();
    ctx.lineWidth = Math.max(1.5, 1.5 * ratio);
    ctx.strokeStyle = "rgba(255, 0, 255, 0.95)";
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 0, 255, 0.12)";
    ctx.fill();
  }
}

// ******** message handling ********

function render(req: RenderRequest): void {
  try {
    if (!initWebgl()) {
      post({ type: "error", message: "WebGL2 unavailable" });
      return;
    }
    if (fieldDirty || !builder) {
      rebuildField();
      fieldDirty = false;
    }
    const { extent, width, height, pixelRatio, resolution, zoom } = req;
    const box: [number, number, number, number] = [
      extent[0],
      extent[1],
      extent[2],
      extent[3],
    ];
    // Only the shaded WebGL surface is drawn at the quality scale (the shading
    // is smooth, so it tolerates it). It is upscaled onto the frame, and the
    // dots, clusters and labels are then drawn at full resolution on top — so
    // every sounding stays sharp and the cluster cell size (which depends on
    // the frame resolution) never coarsens. The frame stays exactly
    // `width × height`, as the API requires.
    const scale = renderScale();
    const surfaceW = Math.max(1, Math.round(width * scale));
    const surfaceH = Math.max(1, Math.round(height * scale));
    const started = performance.now();
    const out = new OffscreenCanvas(width, height);
    const ctx = out.getContext("2d");
    if (!ctx) {
      post({ type: "error", message: "no 2D context" });
      return;
    }
    ctx.clearRect(0, 0, width, height);
    if (builder) {
      renderGpu(box, surfaceW, surfaceH, pixelRatio * scale);
      ctx.drawImage(
        glCanvas as unknown as CanvasImageSource,
        0,
        0,
        surfaceW,
        surfaceH,
        0,
        0,
        width,
        height,
      );
    }
    drawOverlay(ctx, box, width, height, resolution, pixelRatio, zoom);
    const image = out.transferToImageBitmap();
    const frameMs = performance.now() - started;
    // Auto: smooth the cost and adjust only every few frames, with hysteresis,
    // so the surface settles instead of hunting under the user. `drawImage`
    // syncs the GL pass, so the window covers the real per-frame work.
    if ((settings?.quality ?? "auto") === "auto") {
      frameAvgMs =
        frameAvgMs === 0 ? frameMs : frameAvgMs * 0.8 + frameMs * 0.2;
      if (++framesSinceAdjust >= AUTO_ADJUST_EVERY) {
        framesSinceAdjust = 0;
        if (frameAvgMs > AUTO_FRAME_BUDGET_MS * 1.25) {
          autoScale = Math.max(0.4, autoScale - 0.1);
        } else if (frameAvgMs < AUTO_FRAME_BUDGET_MS * 0.6) {
          autoScale = Math.min(1, autoScale + 0.1);
        }
      }
    }
    if (++perfFrames >= PERF_REPORT_EVERY) {
      perfFrames = 0;
      post({ type: "perf", scale, frameMs });
    }
    post({ type: "frame", requestId: req.requestId, image }, [image]);
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
}

function post(message: RenderWorkerOut, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

self.onmessage = (e: MessageEvent<RenderWorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case "base":
      baseSamples = msg.samples;
      fieldDirty = true;
      samplesVersion++;
      break;
    case "live":
      addLive(msg.samples);
      break;
    case "vessel":
      vessel = msg;
      break;
    case "settings": {
      // MSAA is fixed when the GL context is created; drop it so the next
      // render recreates it with the new setting.
      if (msg.settings.msaa !== gpuMsaa) releaseGpu();
      settings = msg.settings;
      fieldDirty = true;
      break;
    }
    case "units":
      depthUnit = msg.depth;
      break;
    case "render":
      render(msg.req);
      break;
    case "release":
      releaseGpu();
      break;
  }
};
