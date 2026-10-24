// The LiveDepth settings panel: a keepAlive iframe the host opens from the
// LiveDepth toolbar button or the layer's "Layer settings" row. It edits the
// extension's state, which the host persists and rebroadcasts (`state.changed`),
// so the runtime picks changes up without a direct connection between the two
// contexts.
//
// Depth-valued settings are shown in the user's preferred depth unit
// (`units.get`) and stored in metres; the history-only settings are greyed while
// the depth source is the plugin's tiles.

import { connectExtension } from "signalk-plotterext-bus/extension";
import {
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  mergeSettings,
  type DepthQuality,
  type DepthSource,
  type LiveDepthSettings,
} from "./shared/settings.js";

/** Metres in a foot. */
const METRES_PER_FOOT = 0.3048;

const client = await connectExtension();
let settings: LiveDepthSettings = { ...DEFAULT_SETTINGS };
let depthUnit: "m" | "foot" = "m";

const root = document.getElementById("root")!;

interface Field {
  key: keyof LiveDepthSettings;
  label: string;
  hint?: string;
  /** A unit shown after the input. */
  suffix?: string;
  /** Shown in the user's depth unit, stored in metres. */
  depth?: boolean;
  /** Only meaningful for the History source; greyed while the source is tiles. */
  historyOnly?: boolean;
}

const FIELDS: Field[] = [
  {
    key: "historyWindowHours",
    label: "History window",
    hint: "How far back to fetch depth.",
    suffix: "h",
    historyOnly: true,
  },
  {
    key: "historyResolutionS",
    label: "Sample interval",
    hint: "Seconds between depth samples; smaller is finer.",
    suffix: "s",
    historyOnly: true,
  },
  {
    key: "shadeLimitMetres",
    label: "Shade limit",
    hint: "Depth the shading runs to; deeper is left to the chart.",
    depth: true,
  },
  {
    key: "contourIntervalMetres",
    label: "Major isobath interval",
    hint: "Depth between index isobaths; every multiple of this is a major contour.",
    depth: true,
  },
  {
    key: "minorContourMetres",
    label: "Minor isobath interval",
    hint: "Depth between the minor isobaths.",
    depth: true,
  },
  {
    key: "fillMetres",
    label: "Fill radius",
    hint: "How far a sounding fills water with no samples; measured cells keep their own depth.",
    suffix: "m",
  },
  {
    key: "cellPx",
    label: "Grid cell",
    hint: "Circle diameter, in screen pixels.",
    suffix: "px",
  },
  {
    key: "mergeTolerance",
    label: "Merge band",
    hint: "Adjacent positions within this depth fraction merge into one circle.",
  },
  {
    key: "maxDepthMetres",
    label: "Max depth",
    hint: "Samples deeper than this are not drawn.",
    depth: true,
  },
  {
    key: "safetyDepthMetres",
    label: "Safety depth",
    hint: "Samples at or below this depth are marked individually.",
    depth: true,
  },
  {
    key: "fieldCells",
    label: "Field resolution",
    hint: "Depth-field cells across the view; higher resolves finer contours.",
  },
  {
    key: "contourWidthPx",
    label: "Major contour width",
    hint: "Major (index) isobar line width.",
    suffix: "px",
  },
  {
    key: "minorContourWidthPx",
    label: "Minor contour width",
    hint: "Minor isobar line width.",
    suffix: "px",
  },
];

interface Toggle {
  key: keyof LiveDepthSettings;
  label: string;
  hint: string;
}

/** Boolean quality switches, rendered as checkboxes. */
const TOGGLES: Toggle[] = [
  {
    key: "fullResolution",
    label: "Full surface resolution",
    hint: "Draw the shaded surface at the display's full size instead of the quality scale (like crowd-depth).",
  },
  {
    key: "vectorContours",
    label: "Vector contours",
    hint: "Draw isobars as vector lines, crisp at any zoom, instead of the per-fragment approximation.",
  },
  {
    key: "msaa",
    label: "Smooth edges (MSAA)",
    hint: "Antialias the WebGL surface edges; applied on the next frame.",
  },
];

interface ColorField {
  key: keyof LiveDepthSettings;
  label: string;
  hint: string;
}

/** String-valued colour settings, rendered as colour pickers. */
const COLOR_FIELDS: ColorField[] = [
  {
    key: "majorContourColor",
    label: "Major contour colour",
    hint: "Colour of the index (major) isobars.",
  },
  {
    key: "minorContourColor",
    label: "Minor contour colour",
    hint: "Colour of the minor isobars.",
  },
];

/** One control in the Graphics Settings group, in display order. */
type GraphicsItem =
  | { kind: "quality" }
  | { kind: "toggle"; key: keyof LiveDepthSettings }
  | { kind: "field"; key: keyof LiveDepthSettings }
  | { kind: "color"; key: keyof LiveDepthSettings };

/** The render controls, grouped at the bottom: quality, contours, full-res,
 * MSAA and the depth-field resolution. */
const GRAPHICS: GraphicsItem[] = [
  { kind: "quality" },
  { kind: "toggle", key: "vectorContours" },
  { kind: "field", key: "contourIntervalMetres" },
  { kind: "field", key: "minorContourMetres" },
  { kind: "field", key: "contourWidthPx" },
  { kind: "field", key: "minorContourWidthPx" },
  { kind: "color", key: "majorContourColor" },
  { kind: "color", key: "minorContourColor" },
  { kind: "toggle", key: "fullResolution" },
  { kind: "toggle", key: "msaa" },
  { kind: "field", key: "fieldCells" },
];

const fieldByKey = new Map(FIELDS.map((field) => [field.key, field]));
const toggleByKey = new Map(TOGGLES.map((toggle) => [toggle.key, toggle]));
const colorByKey = new Map(COLOR_FIELDS.map((field) => [field.key, field]));
const graphicsFieldKeys = new Set(
  GRAPHICS.flatMap((item) => (item.kind === "field" ? [item.key] : [])),
);

const unitSymbol = () => (depthUnit === "foot" ? "ft" : "m");
const toDisplay = (metres: number) =>
  depthUnit === "foot" ? metres / METRES_PER_FOOT : metres;
const fromDisplay = (value: number) =>
  depthUnit === "foot" ? value * METRES_PER_FOOT : value;
const round = (v: number) => Math.round(v * 100) / 100;

const historyRows: HTMLElement[] = [];
const historyInputs: HTMLInputElement[] = [];

/** Grey the history-only fields while the source is the plugin's tiles. */
function syncHistoryDisabled(): void {
  const disabled = settings.source === "tiles";
  for (const input of historyInputs) {
    input.disabled = disabled;
  }
  for (const row of historyRows) {
    row.classList.toggle("disabled", disabled);
  }
}

/** The bounds a field is shown and clamped with, in the unit it is shown in.
 * A depth setting is stored in metres but read in the user's unit; converting
 * the metre bounds outright gives awkward values in feet (0.5 m = 1.64 ft), so
 * a typed whole foot would be snapped away. In feet the bounds are whole
 * numbers and the step is one; in metres they are used as-is. */
function displayBounds(field: Field): {
  min: number;
  max: number;
  step: number;
} {
  const b = SETTINGS_BOUNDS[field.key]!;
  if (!field.depth || depthUnit !== "foot") {
    return b;
  }
  return {
    min: Math.floor(toDisplay(b.min)),
    max: Math.round(toDisplay(b.max)),
    step: 1,
  };
}

function numberField(field: Field): HTMLElement {
  const { min: lo, max: hi, step } = displayBounds(field);

  const wrap = document.createElement("label");
  wrap.className = "field";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = field.label;
  wrap.appendChild(name);

  const control = document.createElement("span");
  control.className = "control";
  const input = document.createElement("input");
  input.type = "number";
  input.min = `${lo}`;
  input.max = `${hi}`;
  input.step = `${step}`;
  const stored = settings[field.key] as number;
  input.value = `${round(field.depth ? toDisplay(stored) : stored)}`;
  input.addEventListener("change", () => {
    const clamped = Math.min(hi, Math.max(lo, Number(input.value)));
    input.value = `${round(clamped)}`;
    (settings[field.key] as number) = field.depth
      ? fromDisplay(clamped)
      : clamped;
    void save();
  });
  control.appendChild(input);
  const suffix = document.createElement("span");
  suffix.className = "suffix";
  suffix.textContent = field.depth ? unitSymbol() : (field.suffix ?? "");
  control.appendChild(suffix);
  wrap.appendChild(control);

  if (field.hint) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = field.hint;
    wrap.appendChild(hint);
  }

  if (field.historyOnly) {
    historyRows.push(wrap);
    historyInputs.push(input);
  }
  return wrap;
}

function toggleField(toggle: Toggle): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field row";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = toggle.label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(settings[toggle.key]);
  input.addEventListener("change", () => {
    (settings[toggle.key] as unknown as boolean) = input.checked;
    void save();
  });
  wrap.append(name, input);
  if (toggle.hint) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = toggle.hint;
    wrap.appendChild(hint);
  }
  return wrap;
}

function build(): void {
  root.replaceChildren();
  historyRows.length = 0;
  historyInputs.length = 0;

  const heading = document.createElement("h2");
  heading.textContent = "LiveDepth";
  root.appendChild(heading);

  const enabled = document.createElement("label");
  enabled.className = "field row";
  const enabledName = document.createElement("span");
  enabledName.className = "name";
  enabledName.textContent = "Show the layer";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = settings.enabled;
  enabledInput.addEventListener("change", () => {
    settings.enabled = enabledInput.checked;
    void save();
  });
  enabled.append(enabledName, enabledInput);
  root.appendChild(enabled);

  const source = document.createElement("label");
  source.className = "field";
  const sourceName = document.createElement("span");
  sourceName.className = "name";
  sourceName.textContent = "Depth source";
  const select = document.createElement("select");
  for (const [value, label] of [
    ["history", "History (this vessel's track)"],
    ["tiles", "LiveDepth plugin tiles"],
  ] as [DepthSource, string][]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = settings.source === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    settings.source = select.value as DepthSource;
    syncHistoryDisabled();
    void save();
  });
  source.append(sourceName, select);
  const sourceHint = document.createElement("span");
  sourceHint.className = "hint";
  sourceHint.textContent =
    "History draws the vessel's own recorded track; tiles draw the " +
    "server-built bathymetry store, extended live.";
  source.appendChild(sourceHint);
  root.appendChild(source);

  for (const field of FIELDS) {
    if (!graphicsFieldKeys.has(field.key)) {
      root.appendChild(numberField(field));
    }
  }

  const graphicsHeading = document.createElement("h3");
  graphicsHeading.textContent = "Graphics Settings";
  root.appendChild(graphicsHeading);

  for (const item of GRAPHICS) {
    if (item.kind === "quality") {
      root.appendChild(qualityField());
    } else if (item.kind === "toggle") {
      const toggle = toggleByKey.get(item.key);
      if (toggle) {
        root.appendChild(toggleField(toggle));
      }
    } else if (item.kind === "color") {
      const color = colorByKey.get(item.key);
      if (color) {
        root.appendChild(colorField(color));
      }
    } else {
      const field = fieldByKey.get(item.key);
      if (field) {
        root.appendChild(numberField(field));
      }
    }
  }
  syncHistoryDisabled();
}

function colorField(field: ColorField): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field row";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = field.label;
  const input = document.createElement("input");
  input.type = "color";
  input.value = settings[field.key] as string;
  input.addEventListener("input", () => {
    (settings[field.key] as unknown as string) = input.value;
    void save();
  });
  wrap.append(name, input);
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = field.hint;
  wrap.appendChild(hint);
  return wrap;
}

/** The render-quality select, shared by the Graphics Settings group. */
function qualityField(): HTMLElement {
  const quality = document.createElement("label");
  quality.className = "field";
  const qualityName = document.createElement("span");
  qualityName.className = "name";
  qualityName.textContent = "Render quality";
  const qualitySelect = document.createElement("select");
  for (const [value, label] of [
    ["auto", "Auto (adapt to this GPU)"],
    ["high", "High"],
    ["balanced", "Balanced"],
    ["low", "Low"],
  ] as [DepthQuality, string][]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = settings.quality === value;
    qualitySelect.appendChild(option);
  }
  qualitySelect.addEventListener("change", () => {
    settings.quality = qualitySelect.value as DepthQuality;
    void save();
  });
  quality.append(qualityName, qualitySelect);
  const qualityHint = document.createElement("span");
  qualityHint.className = "hint";
  qualityHint.textContent =
    "Scales the shaded depth surface only; soundings, circles and labels " +
    "always render at full resolution. Auto adapts to this GPU.";
  quality.appendChild(qualityHint);
  return quality;
}

async function save(): Promise<void> {
  await client.state.set(settings as unknown as Record<string, unknown>);
}

async function load(): Promise<void> {
  try {
    settings = mergeSettings(
      (await client.state.get()) as Record<string, unknown>,
    );
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  try {
    const res = (await client.call("units.get")) as {
      units?: { depth?: string };
    };
    depthUnit = res?.units?.depth === "foot" ? "foot" : "m";
  } catch {
    depthUnit = "m";
  }
  build();
}

await load();
