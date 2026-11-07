# Changelog

All notable changes to this project are documented here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.25] - 2026-11-07

### Changed

- **History rebuilds use six-hour windows again.** One-hour windows looked
  promising, but live testing showed the History provider's per-request
  overhead made main-thread stalls more frequent and longer. The previous
  window size is restored; the lock-contention fixes from 0.3.23 remain.

## [0.3.24] - 2026-11-07

### Changed

- **History rebuilds request smaller windows.** The import now asks the History
  provider for one hour at a time instead of six, so each main-thread response
  is smaller and the sub-second stalls during a rebuild are reduced. The cursor
  also advances in finer steps, so a restart repeats at most an hour.

## [0.3.23] - 2026-11-07

### Fixed

- **A rebuild no longer crashes the live tile writer.** While the history
  import rebuilds the map pyramid it briefly holds the tile database; the live
  writer now retries a busy write on its next tick instead of waiting on the
  main thread and throwing, and the pyramid is written in smaller batches.

## [0.3.22] - 2026-11-07

### Changed

- **History rebuilds keep the live writer responsive.** The import now writes
  folded tiles every 10,000 soundings instead of once per six-hour chunk, so the
  live stream is not left waiting on a chunk-sized database transaction.

## [0.3.21] - 2026-11-07

### Changed

- **History rebuilds no longer stall the server.** The one-time import now runs
  in a worker thread with its own SQLite connection, so folding historical rows,
  writing tiles and rebuilding the map pyramid no longer block Signal K's event
  loop. The History API provider stays in the main process; the worker requests
  each window over a message port, and the live writer and import share the
  database through WAL with a short busy timeout.

## [0.3.20] - 2026-11-07

### Fixed

- **An interrupted history rebuild now resumes.** A server or plugin restart
  aborts the rebuild, but the one-time trigger was cleared anyway, so the next
  start did not resume and the rebuild looked finished. An interrupted run now
  leaves the trigger set and continues from the last completed chunk; it is
  cleared only when the rebuild completes (or fails).

## [0.3.19] - 2026-11-07

### Added

- **Tide-corrected soundings.** With tide correction on, every depth is reduced
  to a fixed chart datum (LAT or MLLW) using the predicted water level at that
  sample's time and position, so soundings from different days and different
  vessels share one grid. The Slackwater station database ships with the
  plugin, so nothing is downloaded. The chart is told the datum in the plugin
  metadata and stops folding its own live depth onto the corrected grid.

### Changed

- **Depth is always read from a Signal K depth path.** The external
  tide-compensated paths (`belowSurfaceTideCompensated`, `…LAT`, `…MLLW`) are
  removed; tide compensation now happens inside the plugin. Point the Depth
  setting at `environment.depth.belowSurface` and turn tide correction on.
- **The Depth selector is disabled while tide correction is on**, with a note
  that changing the datum clears the grid because the stored cells are depths
  in the old datum.

### Fixed

- **A history rebuild no longer races the history provider.** The plugin waits
  up to 30 s for the History API provider to register before falling back to
  the HTTP endpoint, so a rebuild at server start no longer fails instantly.
- **Older pinned Slackwater versions are supported.** The tide predictor is
  awaited, which works whether `nearestStation` returns a promise or the
  predictor directly.

## [0.3.18] - 2026-11-02

### Changed

- **The layer now always draws the plugin's bathymetry grid.** The History API
  is no longer offered as a depth source in the layer's settings; the source
  selector and its history-only window/interval fields are gone. The separate
  History import in the plugin's server settings is unchanged — that is what
  seeds the grid. Settings saved with the old History source migrate
  automatically.

## [0.3.17] - 2026-11-01

### Fixed

- **The extension no longer disappears after saving the plugin configuration.**
  Saving stops and starts the plugin, and the server unregisters a plugin's
  resource providers on stop. Registration was guarded by a module-level flag
  that outlived the restart, so the extension dropped out of
  `/signalk/v2/api/resources/plotterExtensions` even though depth collection
  resumed. The provider is now registered on every start.

## [0.3.16] - 2026-11-01

### Added

- **Tide-compensated depth sources.** A tide-compensated rig that publishes
  `environment.depth.belowSurfaceTideCompensated` (and the `LAT` and `MLLW`
  variants) can now be chosen as the datum to record.

## [0.3.15] - 2026-11-01

### Fixed

- **The layer no longer freezes into large blocks after the tab is left in the
  background.** Chromium can evict a hidden tab's WebGL context; the worker
  kept drawing into the dead context, so the next frame was garbage and every
  render after it failed. A lost context is now detected, the renderer is
  re-initialised and the depth field re-uploaded, and the frame cycle is reset
  if the worker stops answering.

### Changed

- **A hidden tab parks all rendering work.** On `visibilitychange` the frame
  cycle, live flush, history poll and tile fetches stop until the tab is shown
  again, so a background Freeboard stays close to idle (and is far less likely
  to lose its context in the first place).
- The overlay view is padded to match the host's 10% margin, so a pan inside
  the host's cached frame no longer forces a re-render.

## [0.3.13] - 2026-10-26

### Changed

- **Following the vessel no longer rebuilds the depth grid on every step.** The
  tiles are fetched for a box 1.5× the view, and while the view stays inside it
  the fetched tiles and the built depth field are reused. The grid is only
  rebuilt when the view leaves the padding (or new tile data arrives).

## [0.3.12] - 2026-10-26

### Changed

- **Following the vessel no longer re-renders the depth surface every update.**
  The surface is rendered for a view padded by 25% on each side, and a pan
  inside that padding reuses it by blitting the covered sub-rectangle instead
  of re-running the full-screen shader.
- The frame canvas is reused between requests instead of allocating a fresh
  full-window canvas (and clearing it) every frame.

## [0.3.11] - 2026-10-24

### Changed

- **Cached surface and overlay.** The host requests a frame far more often than
  the depth field or the view changes; the worker now reuses the rendered
  surface and the drawn overlay until a key (field version, extent, size,
  settings) changes, instead of re-running the full-screen shader and the 2D
  pass on every request.

## [0.3.10] - 2026-10-24

### Changed

- **Sounding markers**: a cluster's small dot is drawn only when its depth
  label is not, so labelled clusters show just the text. Reverted the 0.3.9
  full-radius circle.

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
