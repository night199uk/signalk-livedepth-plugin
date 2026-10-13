import { ServerAPI } from "@signalk/server-api";

export type Config = {
  /** Which depth datum to record. Signal K already publishes each relative to
   * its own reference, so the value is stored as-is. */
  path: (typeof DepthPaths)[number];
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
  seed?: {
    run?: boolean;
    resolution?: number;
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
  return {
    type: "object",
    description:
      "Build a gridded bathymetry tile store from the vessel's own position and depth, and serve it to a chart client's LiveDepth layer.",
    properties: {
      path: {
        type: "string",
        title: "Depth",
        description:
          "Which depth datum to record. Signal K publishes each relative to its own reference, so no draft or transducer offset is needed here.",
        enum: DepthPaths,
        enumNames: [
          "Depth below surface",
          "Depth below transducer",
          "Depth below keel",
        ],
        default: defaultPath,
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
            default: app.getSelfPath("sensors.depth.fromBow.value"),
          },
          x: {
            type: "number",
            title: "Distance of the transducer from the center (meters)",
            description: "+ve to starboard, -ve to port",
            default: app.getSelfPath("sensors.depth.fromCenter.value"),
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
    },
  };
}
