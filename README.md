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

## What you need

- A Signal K server with your depth sounder and GPS feeding it.
- A chartplotter that supports plotter extensions — Freeboard-SK.
- The plugin enabled on the server (install it from the App Store, then switch it
  on in the server's plugin settings).

## Using it

Once enabled, **Live depth** appears in the chartplotter's Chart list, under
_Plugin layers_, with its own show/hide and opacity controls — saved just like a
chart's. Open **Layer settings** on its row (or the LiveDepth toolbar button) to
choose what it shows:

- **Show the layer** — on or off.
- **Depth source** — your own recent track, or the accumulated depth map.
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
  keel).
- **Depth transducer** — where the sounder sits on the hull, so each reading is
  placed at it rather than at the position the server reports.
- **Transducer position correction** — shift readings from the vessel's
  reference point to the transducer (needs the server's own GNSS correction on).
- **Rebuild from history** — a one-time rebuild of the depth map from the track
  the server already has.

## How it works

The plugin runs on your Signal K server and turns each sounding into a
Web-Mercator depth map, keeping the shallowest reading for every spot. A
chartplotter that supports plotter extensions draws it as a map layer, rendering
in the browser. The plugin offers the layer to the chartplotter automatically —
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
