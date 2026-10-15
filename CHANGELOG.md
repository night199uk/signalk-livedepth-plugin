# Changelog

All notable changes to this project are documented here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
