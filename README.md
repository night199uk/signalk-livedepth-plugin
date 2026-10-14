# signalk-livedepth-plugin

A Signal K server plugin with two halves that ship as one package:

- a **gridded bathymetry tile store** built from the vessel's own position and
  depth, and
- the **LiveDepth chart layer** — a [plotter extension](https://github.com/SignalK/freeboard-sk/blob/master/docs/api/plotter-extensions-api.md)
  that draws that depth on a compatible chartplotter (Freeboard-SK) as a shaded
  surface with isobaths, without the chartplotter needing any LiveDepth code of
  its own.

## The tile store

- Subscribes to the vessel's own `environment.depth.*` and `navigation.position`
  and folds each sounding into a Web-Mercator XYZ tile store: 256-cell tiles,
  base level `z20` (≈0.15 m per cell), min-pooled down to `z4` (≈2.4 km per
  cell). A tile is stored sparsely — only the cells a sounding fell in — as a
  5-byte record (`cx, cy, depthCm, count`) keeping the shallowest depth, so
  zooming out never deepens a shoal. The algorithm lives in `src/tiles/core/`,
  imported by both the plugin's server side and the extension's browser bundle,
  so the two build identical tiles.
- Serves the tiles so a client can draw a depth surface for the area without
  replaying the raw track or interpolating at query time.
- Can seed the store from the server's History API at the finest granularity it
  offers — a one-time, resumable rebuild for a store that already has a track.

## The chart layer

The plugin registers a `plotterExtensions` manifest offering one `image`
overlay, drawn by a headless background runtime:

- The **runtime** owns the soundings — from the server's History API (the
  vessel's own recent track) or from the tile store, extended live from the
  Signal K stream — and answers the host's `overlay.request` with a frame.
- A **render Worker** builds the depth field once per data change, shades it and
  draws isobaths with WebGL2, adds the shoal/cluster dots and depth labels on a
  2D canvas, and hands the result back as an `ImageBitmap`.
- A **settings panel** (opened from the layer's row in the chartplotter's Chart
  list, or from the LiveDepth toolbar button) sets the depth source, the shading
  and contour ranges, the grid cell, the merge band and the depths drawn.

The layer appears in the chartplotter's Chart list under _Plugin layers_, with
its own show/hide and opacity controls, saved like a chart's.

## Routes

Served from the extension's own top-level namespace (non-admin, so a read-only
user's chartplotter can reach it):

| Route                                            | Returns                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /plotterext/<id>/bathymetry/meta`           | grid spec (base/min zoom, tile size, record size) and the depth path/offsets to mirror |
| `GET /plotterext/<id>/bathymetry/tiles/:z/:x/:y` | the sparse tile blob (`application/octet-stream`), or `404`                            |
| `GET /plotterext/<id>/renderer.html`             | the background runtime                                                                 |
| `GET /plotterext/<id>/config.html`               | the settings panel                                                                     |

Admin only, on the plugin's own router:

| Route                                | Returns                                    |
| ------------------------------------ | ------------------------------------------ |
| `GET /plugins/<id>/bathymetry/seed`  | status of the one-time history rebuild     |
| `POST /plugins/<id>/bathymetry/seed` | start the one-time history rebuild (`202`) |

`<id>` is `signalk-livedepth-plugin`.

## Configuration

- **Path** — the `environment.depth.*` path to record.
- **Depth Transducer** — where the transducer sits on the hull, so a sounding is
  placed at it rather than at the position the server reports.
- **Transducer position correction** — shift each sounding from the vessel
  reference point to the transducer (only meaningful with the server's own GNSS
  correction on).
- **Rebuild from History** — a one-shot rebuild from the server's History API;
  it fires once when saved and clears itself when it finishes.

## Development

```bash
npm install
npm run build          # tsc -b (dist/) + web typecheck + esbuild (public/)
npm run build:plugin   # tsc -b only
npm run build:web      # esbuild the extension pages into public/
npm run typecheck:web  # tsc -p tsconfig.web.json
npm test               # vitest
npm run format
npm run lint
```

Node `>=22.5` (the store uses the built-in `node:sqlite`).
