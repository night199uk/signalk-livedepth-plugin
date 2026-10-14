// The LiveDepth settings panel: a keepAlive iframe the host opens from the
// LiveDepth toolbar button. It edits the extension's state, which the host
// persists and rebroadcasts (`state.changed`), so the runtime picks changes up
// without a direct connection between the two contexts.

import { connectExtension } from "signalk-plotterext-bus/extension";
import {
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  mergeSettings,
  type DepthSource,
  type LiveDepthSettings,
} from "./shared/settings.js";

const client = await connectExtension();
let settings: LiveDepthSettings = { ...DEFAULT_SETTINGS };

const root = document.getElementById("root")!;

interface Field {
  key: keyof LiveDepthSettings;
  label: string;
  hint?: string;
}

const NUMBER_FIELDS: Field[] = [
  {
    key: "historyWindowHours",
    label: "History window",
    hint: "How far back to fetch depth, in hours.",
  },
  {
    key: "historyResolutionS",
    label: "Sample interval",
    hint: "Seconds between depth samples.",
  },
  {
    key: "shadeLimitMetres",
    label: "Shade limit",
    hint: "Depth the shading runs to, in metres; deeper is left to the chart.",
  },
  {
    key: "contourIntervalMetres",
    label: "Isobath interval",
    hint: "Metres between isobaths.",
  },
  { key: "cellPx", label: "Grid cell", hint: "Circle diameter, in pixels." },
  {
    key: "mergeTolerance",
    label: "Merge band",
    hint: "Adjacent positions within this depth fraction merge into one circle.",
  },
  {
    key: "maxDepthMetres",
    label: "Max depth",
    hint: "Samples deeper than this are not drawn.",
  },
  {
    key: "safetyDepthMetres",
    label: "Safety depth",
    hint: "Samples at or below this depth are marked individually.",
  },
];

function numberField(field: Field): HTMLElement {
  const bounds = SETTINGS_BOUNDS[field.key]!;
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.innerHTML = `<span class="name">${field.label}</span>`;
  const input = document.createElement("input");
  input.type = "number";
  input.min = `${bounds.min}`;
  input.max = `${bounds.max}`;
  input.step = `${bounds.step}`;
  input.value = `${settings[field.key]}`;
  input.addEventListener("change", () => {
    const clamped = Math.min(
      bounds.max,
      Math.max(bounds.min, Number(input.value)),
    );
    input.value = `${clamped}`;
    (settings[field.key] as number) = clamped;
    void save();
  });
  wrap.appendChild(input);
  if (field.hint) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = field.hint;
    wrap.appendChild(hint);
  }
  return wrap;
}

function build(): void {
  root.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = "LiveDepth";
  root.appendChild(heading);

  const enabled = document.createElement("label");
  enabled.className = "field row";
  enabled.innerHTML = `<span class="name">Show the layer</span>`;
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = settings.enabled;
  enabledInput.addEventListener("change", () => {
    settings.enabled = enabledInput.checked;
    void save();
  });
  enabled.appendChild(enabledInput);
  root.appendChild(enabled);

  const source = document.createElement("label");
  source.className = "field";
  source.innerHTML = `<span class="name">Depth source</span>`;
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
    void save();
  });
  source.appendChild(select);
  const sourceHint = document.createElement("span");
  sourceHint.className = "hint";
  sourceHint.textContent =
    "History draws the vessel's own recorded track; tiles draw the " +
    "server-built bathymetry store, extended live.";
  source.appendChild(sourceHint);
  root.appendChild(source);

  for (const field of NUMBER_FIELDS) {
    root.appendChild(numberField(field));
  }
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
  build();
}

await load();
client.subscribe(["state.changed"], () => void load());
