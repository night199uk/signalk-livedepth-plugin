import { ServerAPI } from "@signalk/server-api";
import { TIDE_DATUMS, TideDatum } from "./tide.js";

export type Config = {
  /** Which depth measurement to record when tide correction is off. Signal K
   * already publishes each relative to its own reference, so it is stored
   * as-is. With tide correction on, the raw depth below the surface is used
   * and reduced to {@link Config.tide.datum} instead. */
  path: (typeof DepthPaths)[number];
  /** Reduce each sounding to a fixed vertical datum, using the predicted tide
   * at that sounding's own time and position. */
  tide?: {
    enabled?: boolean;
    datum?: TideDatum;
  };
  /** The depth transducer's position on the hull: `y` from the bow, `x` from
   * the centreline (+starboard). Used only to place a sounding at the
   * transducer rather than at the position the server reports. */
  sounder: {
    x: number;
    y: number;
  };
  /** Shift soundings from the vessel reference point the server reports to the
   * transducer. `off` leaves them where the server put them. */
  transducerCorrection: "off" | "replace";
  /** Which vessels to record soundings from. By default every vessel that
   * publishes a depth on the selected datum is recorded — a tender or a second
   * sounder-equipped vessel is picked up automatically, while AIS targets
   * (position but no depth) are ignored. `include`/`exclude` narrow that set. */
  vessels?: {
    include?: string[];
    exclude?: string[];
  };
  /** Skip a sounding from another vessel that is sitting next to us but
   * reporting a depth that cannot be the water we are in — a tender on davits
   * has its transducer in air and still reports a plausible-looking number.
   * Compared against this vessel's own depth and position. */
  coLocatedDepth?: {
    enabled?: boolean;
    radiusM?: number;
    depthM?: number;
  };
  seed?: {
    run?: boolean;
    resolution?: number;
  };
  /** Temporary diagnostics, removed once the geometry is verified. */
  debug?: {
    /** Draw the vessel's footprint (LOA × beam) in the chart layer. */
    vesselFootprint?: boolean;
  };
};

export const DepthPaths = [
  "belowSurface",
  "belowTransducer",
  "belowKeel",
] as const;

export function schema(app: ServerAPI) {
  const defaultPath = DepthPaths.find((path) =>
    app.getSelfPath(`environment.depth.${path}.value`),
  );
  // A `default` is attached only when present: `default: undefined` survives in
  // the object but is dropped when the server stores the schema as JSON, which
  // its plugin schema check flags as data loss.
  const fromBow = app.getSelfPath("sensors.depth.fromBow.value");
  const fromCenter = app.getSelfPath("sensors.depth.fromCenter.value");
  return {
    type: "object",
    description:
      "Build a gridded bathymetry tile store from vessel soundings — your own and any other depth-equipped vessel on the server — and serve it to a chart client's LiveDepth layer.",
    properties: {
      path: {
        type: "string",
        title: "Depth",
        description:
          "Which depth measurement to record. Signal K publishes each relative to its own reference, so no draft or transducer offset is needed here. When tide correction is on, the raw depth below the surface is used instead and reduced to the chosen datum.",
        enum: DepthPaths,
        enumNames: [
          "Depth below surface",
          "Depth below transducer",
          "Depth below keel",
        ],
        ...(defaultPath === undefined ? {} : { default: defaultPath }),
      },
      tide: {
        type: "object",
        title: "Tide correction",
        description:
          "Store soundings relative to a fixed vertical datum by subtracting the predicted tide at each sounding's own time and position. A depth below the surface rises and falls with the tide; a depth below a datum does not, so it still means the same thing when you return months later. When this is on, the raw depth below the surface is recorded and the Depth setting is ignored. Changing the datum clears the depth map, because the stored cells are depths in the old datum.",
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            title: "Correct samples for tides?",
            description:
              "Off records the selected Depth as measured. On records the depth below the surface reduced to the datum below.",
          },
          datum: {
            type: "string",
            title: "Datum",
            enum: TIDE_DATUMS,
            enumNames: [
              "Chart datum / local datum",
              "Lowest Astronomical Tide (LAT)",
              "Mean Lower Low Water (MLLW)",
            ],
            default: "LAT",
            description:
              "LAT and MLLW are fixed references at each location, so a corrected sounding keeps its meaning wherever and whenever you return. Chart datum is set per chart region, so a map corrected to it cannot be compared across regions; LAT and MLLW are the predictable choices.",
          },
        },
      },
      sounder: {
        type: "object",
        title: "Depth Transducer",
        description:
          "Where the transducer sits on the hull, so a sounding is placed at it rather than at the position the server reports.",
        required: ["x", "y"],
        properties: {
          y: {
            type: "number",
            title: "Distance of the transducer from the bow (meters)",
            minimum: 0,
            ...(fromBow === undefined ? {} : { default: fromBow }),
          },
          x: {
            type: "number",
            title: "Distance of the transducer from the center (meters)",
            description: "+ve to starboard, -ve to port",
            ...(fromCenter === undefined ? {} : { default: fromCenter }),
          },
        },
      },
      transducerCorrection: {
        type: "string",
        title: "Transducer position correction",
        description:
          "Shift each sounding from the vessel reference point the server reports to the transducer. This is only meaningful when the server's own GNSS correction is on (Server → Settings → Vessel → GNSS correction): otherwise the position is the GNSS antenna, not the vessel reference point, and the offset is applied from the wrong place.",
        enum: ["off", "replace"],
        enumNames: ["Off", "Replace with the transducer's position"],
        default: "off",
      },
      vessels: {
        type: "object",
        title: "Vessels",
        description:
          "Which vessel contexts to record. By default every vessel that publishes a depth on the selected datum is recorded — a tender or a second depth-equipped vessel is picked up automatically, while AIS targets (position but no depth) are ignored. Use these lists to narrow that set.",
        properties: {
          include: {
            type: "array",
            title: "Only these vessels",
            description:
              "Record only these Signal K contexts, e.g. vessels.urn:mrn:signalk:uuid:…. Empty records every vessel that publishes a depth.",
            items: { type: "string" },
          },
          exclude: {
            type: "array",
            title: "Never these vessels",
            description: "Contexts to ignore even when they publish a depth.",
            items: { type: "string" },
          },
        },
      },
      coLocatedDepth: {
        type: "object",
        title: "Ignore a nearby vessel's implausible depth",
        description:
          "A tender on davits or in a cradle still reports a depth (its transducer is in air, and the number often looks plausible). While another vessel is within this distance of us and its depth differs from ours by more than the tolerance, its soundings are skipped. Our own soundings are never filtered.",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            title: "Enabled",
            description:
              "Compare another vessel's depth with ours while it is close to us.",
          },
          radiusM: {
            type: "number",
            default: 15,
            minimum: 0,
            title: "Nearby radius (meters)",
            description:
              "Only a vessel this close to us is compared. Soundings further away are always kept.",
          },
          depthM: {
            type: "number",
            default: 2,
            minimum: 0,
            title: "Depth difference (meters)",
            description:
              "A depth this far from ours, while the vessel is nearby, is treated as out of the water and skipped.",
          },
        },
      },
      seed: {
        type: "object",
        title: "Rebuild from History",
        description:
          "Rebuild the gridded bathymetry tiles from the server's History API at the finest granularity it offers. Slow — it reads the whole record — so run it once; the live stream keeps the tiles current afterwards, and an interrupted run resumes where it stopped.",
        properties: {
          run: {
            type: "boolean",
            default: false,
            title: "Rebuild the bathymetry tiles from history now",
            description:
              "Starts the rebuild when the configuration is saved. Resets itself when it finishes; leave off to skip.",
          },
          resolution: {
            type: "number",
            default: 0.1,
            title: "History resolution (seconds)",
            description:
              "Granularity to read. The provider floors this at its native cadence; 0.1 keeps nearly every fix.",
          },
        },
      },
      debug: {
        type: "object",
        title: "Debug",
        description:
          "Temporary diagnostics, not for general use — they will be removed.",
        properties: {
          vesselFootprint: {
            type: "boolean",
            default: false,
            title: "Draw the vessel footprint",
            description:
              "Draw the vessel's footprint (design.length.overall × design.beam) on the chart layer, centred on navigation.position and rotated to the heading. Useful for checking where soundings land relative to the hull.",
          },
        },
      },
    },
  };
}
