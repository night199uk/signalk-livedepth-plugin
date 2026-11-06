# LiveDepth

**LiveDepth builds and visualises a depth map from your own soundings, in real
time, as your vessel moves.** Everywhere you go, your depth sounder's readings
are turned into bathymetric data you can see on the chart — so the ground you've
already covered is there to look at the next time you're in the area.

## What it does

- **Records as you go.** Each depth reading is placed where your vessel was when
  it was taken, building a picture of the seabed along your track. No surveying
  needed — just your normal boating.
- **Draws it on the chart.** A compatible chartplotter (Freeboard-SK) shows the
  depth as a shaded surface with depth-contour lines, so you can see the shape of
  the ground and where it shallows.
- **Never hides a shoal.** Where readings overlap, the shallowest one wins, so
  zooming out can't bury a shallow patch under the deeper water around it.
- **Live or accumulated.** Show your own recent track, or the depth map the
  server has built up over time — extended live as you move.
- **Rebuild from history.** Already have a track recorded on the server? A
  one-time rebuild fills the map in from it.
- **Comparable across days.** Optionally reduce every sounding to a fixed
  vertical datum (LAT or MLLW) using the tide predicted at the moment and place
  it was taken, so a depth recorded months ago still means the same thing.

## What you need

- A Signal K server with your depth sounder and GPS feeding it.
- A chartplotter that supports plotter extensions — **Freeboard-SK
  3.4.0-beta.0 or later**, or another host that supports the `overlays.image`
  capability.
- The plugin enabled on the server (install it from the App Store, then switch it
  on in the server's plugin settings).

## Using it

Once enabled, **Live depth** appears in the chartplotter's Chart list, under
_Plugin layers_, with its own show/hide and opacity controls — saved just like a
chart's. Open **Layer settings** on its row (or the LiveDepth toolbar button) to
choose what it shows:

- **Show the layer** — on or off.
- **Shade limit** — the depth the shading runs to; deeper water is left to the
  chart.
- **Isobath interval** — how far apart the depth-contour lines are.
- **Grid cell**, **Merge band** — how readings are grouped into the dots on the
  chart.
- **Max depth**, **Safety depth** — which readings are drawn, and which shallow
  ones are marked individually.

Depth values are shown in your preferred units.

## Server settings

- **Path** — which depth measurement to record (below surface, transducer or
  keel). Ignored when tide correction is on, which always uses the raw depth
  below the surface.
- **Tide correction** — store soundings relative to a fixed vertical datum
  instead of the moving surface. Choose chart datum, **LAT** or **MLLW**. LAT
  and MLLW are fixed references at each location, so a corrected depth keeps its
  meaning when you return; chart datum changes with the chart region. Each
  sounding — live, rebuilt from history, or recorded by another vessel — is
  reduced using the tide predicted at its own time and position. Changing the
  datum clears the map, because the stored cells are depths in the old datum;
  run **Rebuild from history** to repopulate it.
- **Depth transducer** — where the sounder sits on the hull, so each reading is
  placed at it rather than at the position the server reports.
- **Transducer position correction** — shift readings from the vessel's
  reference point to the transducer (needs the server's own GNSS correction on).
- **Rebuild from history** — a one-time rebuild of the depth map from the track
  the server already has.

## How it works

The plugin runs on your Signal K server and turns each sounding into a
Web-Mercator depth map, keeping the shallowest reading for every spot. With tide
correction on it predicts the water level from the station database bundled with
the plugin (Slackwater) — offline, for any past or future instant — and
subtracts it before the reading reaches the map; a reading whose tide cannot be
predicted is skipped rather than stored in the wrong datum. Because the browser
cannot correct its own live readings, the layer then draws the corrected server
tiles (refreshed as new soundings arrive) instead of adding the raw live depth on
top. A chartplotter that supports plotter extensions draws it as a map layer,
rendering in the browser. The plugin offers the layer to the chartplotter automatically —
there's nothing to configure on the chart side.

## Development

```bash
npm install
npm run build   # server code (dist/) + the chart-layer pages (public/)
npm test        # vitest
npm run format
npm run lint
```

Node `>=22.5`.
