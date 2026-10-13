# signalk-livedepth-plugin

A Signal K server plugin that builds a **gridded bathymetry tile store** from the
vessel's own position and depth, and serves it to a chart client's LiveDepth
layer. It is the server side of Freeboard-SK's LiveDepth layer.

## What it does

- Subscribes to the vessel's own `environment.depth.*` and `navigation.position`,
  and folds each sounding into a Web-Mercator XYZ tile store: 256-cell tiles,
  base level `z20` (≈0.15 m per cell), min-pooled down to `z4` (≈2.4 km per
  cell). A tile is stored sparsely — only the cells a sounding fell in — as a
  5-byte record (`cx, cy, depthCm, count`) keeping the shallowest depth, so
  zooming out never deepens a shoal. The tile algorithm itself lives in
  [`signalk-livedepth-tiles`](https://www.npmjs.com/package/signalk-livedepth-tiles),
  shared with the chart client so both build identical tiles.
- Serves the tiles over HTTP so a chart client can draw a depth surface for the
  area without replaying the raw track or interpolating at query time.
- Can seed the store from the server's History API at the finest granularity it
  offers — a one-time, resumable rebuild for a store that already has a track.

## Routes

Mounted by the server at `/plugins/signalk-livedepth-plugin`:

| Route                            | Returns                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /bathymetry/meta`           | grid spec (base/min zoom, tile size, record size) and the depth path/offsets to mirror |
| `GET /bathymetry/tiles/:z/:x/:y` | the sparse tile blob (`application/octet-stream`), or `404`                            |
| `GET /bathymetry/seed`           | admin only: status of the one-time history rebuild                                     |
| `POST /bathymetry/seed`          | admin only: start the one-time history rebuild (`202`)                                 |

A client seeds its view from the tiles, then keeps its own copy current from the
same Signal K stream.

## Configuration

- **Path** — the `environment.depth.*` path to record.
- **Depth Sounder / GPS Receiver** — the sensor offsets, and the source to pin
  each path to (so soundings from a second GPS don't smear the track).
- **Rebuild from History** — a one-shot rebuild from the server's History API;
  it fires once when saved and clears itself when it finishes.

## Development

```bash
npm install
npm run build     # tsc -b  ->  dist/
npm test          # vitest
npm run format
npm run lint
```

Node `>=22.5` (the store uses the built-in `node:sqlite`).
