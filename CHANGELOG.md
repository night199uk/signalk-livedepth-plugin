# Changelog

All notable changes to this project are documented here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.9] - 2026-10-24

### Changed

- **Sounding clusters** are drawn as a filled circle sized to their spatial
  extent (`radiusMetres`) instead of a fixed centre dot, so a run of similar
  soundings reads as a full circle. Individual shoals keep the small dot.

## [0.3.8] - 2026-10-24

### Changed

- Reverted the 0.3.7 sounding-dot tint: the centre marker uses the depth
  palette again (so it is white, not blue, in deep water).

## [0.3.6] - 2026-10-24

### Changed

- **Depth shading** now uses the Navionics SonarChart water palette: azure in
  shallow water, fading through pale blues to white at the shade limit.
- **Vector contours** are split into major (index) and minor lines, with
  configurable intervals, widths and colours.
- **Graphics Settings** group in the panel; isobath intervals sit with the depth
  settings.

### Fixed

- The render worker URL carries the package version, so a browser no longer
  keeps running a previous build after an update.

## [0.3.5] - 2026-10-23

### Added

- **Vector contours**, so the isobars stay crisp at any zoom (the vector-tile
  look) instead of being limited by the depth-field raster. The shaded surface
  can render at **full resolution** (ignoring the quality scale) and with
  **MSAA**. Advanced controls in the settings panel: full-resolution surface,
  vector contours, smooth edges, field resolution, and contour width.

## [0.3.4] - 2026-10-21

### Added

- **Wider depth fill.** A sounding now fills water it has no samples for, out
  to a configurable **Fill radius** (default 6 m), with a linear gradient so
  adjacent tracks blend across the gap instead of leaving a hairline track that
  takes many passes to fill in. The cell a sounding lands in keeps its own
  depth, and the fill is capped a couple of metres above the shallowest sample
  in range, so a sharp depth change (a contour) is not smeared over.

## [0.3.3] - 2026-10-20

### Added

- **Ignore a nearby vessel's implausible depth.** A tender on its davits still
  publishes a depth — its transducer is in air and the number often looks
  plausible — and those soundings would otherwise be written next to the
  mothership. A sounding is now skipped when its vessel is within
  `coLocatedDepth.radiusM` (default 15 m) of us and its depth differs from ours
  by more than `coLocatedDepth.depthM` (default 2 m). Our own soundings, and
  those from vessels further away, are never filtered.

## [0.3.2] - 2026-10-19

### Added

- Depth from **other vessels**. The plugin now records any vessel on the server
  that publishes a depth on the selected datum, so a tender or a second
  sounder-equipped vessel (for example a dinghy) is folded into the bathymetry
  automatically. AIS targets — which have a position but no depth — are ignored.
  The transducer correction describes this vessel's hull, so it is applied to
  this vessel's soundings only. `vessels.include` / `vessels.exclude` narrow the
  set if needed.
- A **Render quality** setting: Auto, or High / Balanced / Low. It scales only
  the shaded depth surface; soundings, circles and labels always render at full
  resolution. Auto adapts the surface to the GPU, and a frame-rate readout is
  logged to the console.
- A temporary `debug.vesselFootprint` option draws the vessel's LOA × beam on
  the chart layer, for checking where a sounding lands relative to the hull.

### Fixed

- A transducer forward of midships is placed ahead of the reference, not behind
  it. The offset sign was inverted, which drew every sounding astern.
- The chart layer accepts the host's object-shaped `navigation.position`
  (`{ latitude, longitude }`), so live soundings are no longer silently dropped.
- Panning or zooming re-fetches the tiles for the new view; previously the layer
  kept drawing the previous view's tile set.
- A vessel that goes quiet keeps its subscription, so the deltas it replays on
  reconnect are recorded rather than lost. A GPS-only vessel with no compass
  falls back to course over ground for its heading.

### Changed

- The chart layer renders at the display's pixel ratio instead of oversampling
  at 2×, caches the per-frame cluster aggregation, and patches the depth field
  incrementally on a live flush instead of rebuilding the grid. This cuts the
  browser's CPU/GPU cost substantially, especially on a lower-powered GPU.

## [0.3.1] - 2026-10-16

### Fixed

- The chart layer no longer lags the vessel by 2–3 seconds. Live soundings were
  batched for two seconds, and each batch re-fetched every tile for the view
  over HTTP; they now fold into the frame every 300 ms without a network round
  trip, so the surface fills in under the bow.

## [0.3.0] - 2026-10-15

The LiveDepth chart layer, and the merge that brings everything into one
package. The chart layer needs a host that implements `overlays.image` —
Freeboard-SK **3.4.0-beta.0 or later**.

### Added

- The **LiveDepth chart layer**: an image map overlay offered to
  plotter-extensions chartplotters (Freeboard-SK 3.4.0-beta.0 or later), drawn
  by a headless background runtime that shades the depth surface, draws isobaths
  and
  labels the shoals. It appears in the chartplotter's Chart list with show/hide
  and opacity controls, and its settings open from the layer's row or the
  LiveDepth toolbar button.

### Changed

- The shared tile algorithm (`signalk-livedepth-tiles`) is folded into this
  package under `src/tiles/core/`; that published package is no longer a
  dependency.
- Bathymetry data is served from the extension's own top-level path
  (`/plotterext/signalk-livedepth-plugin/bathymetry/…`) so a read-only user's
  chartplotter can reach it; the one-time history rebuild stays an admin route.

### Fixed

- The config schema no longer emits a `default: undefined`, which the server
  dropped when storing the schema as JSON.
- Switching the depth source now takes effect: the live Signal K subscription
  starts and stops with the source.
- The settings panel greys the history-only fields while the depth source is the
  plugin's tiles, and shows depth values in the user's preferred unit.

## [0.2.1] - 2026-10-14

### Fixed

- Serve tiles as raw bytes, not JSON — express was JSON-encoding the `Uint8Array`
  `encodeTile` returns, so a client decoded the JSON text as sparse records.
- Read the vessel length overall from `design.length`, so transducer correction
  no longer reports it missing on servers that have it.

## [0.2.0] - 2026-10-14

### Added

- Transducer position correction.

### Changed

- Trimmed the configuration to the depth path, the transducer's position, the
  correction mode and the one-time history rebuild.

## [0.1.0] - 2026-10-13

### Added

- First release: build a gridded bathymetry tile store from the vessel's own
  position and depth, serve it to a chart client, and seed it from the server's
  History API.
