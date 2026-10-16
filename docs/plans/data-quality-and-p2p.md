# LiveDepth: a shared bathymetry dataset

**Status:** design — this describes where we want to be, not what exists today.

The aim is a **common bathymetry dataset**: the soundings many vessels collect,
merged into one body of water every participating boat draws on, that describes
its own quality well enough to be trusted and compared in the terms charts
already use ([IHO/NOAA outline](https://github.com/openwatersio/crowd-depth/blob/main/docs/plans/global-grid/standards.md)).

Two things have to be true for that to work: each sounding must **carry its own
quality** (who measured it, how well, relative to what), and instances must
**share** the data without a central authority arbitrating the merge. These are a
single design, because the first is a set of per-sounding attributes and the
second replicates exactly those.

---

## 1. The dataset

### 1.1 Shape

A sparse Web-Mercator XYZ tile store. Level `z` splits the world into `2^z` tiles
of 256×256 cells; a tile holds only the cells a sounding fell in. Coarser levels
are the **min-pooled parents** of the finer ones, so a shoal survives any
zoom-out.

### 1.2 Properties the dataset must have

- **Convergent.** Any two instances that have exchanged everything hold the same
  data, whichever order they exchanged it in and with no coordination.
- **Verifiable.** A peer cannot silently alter history; a receiver can tell a
  block was modified.
- **Sparsely fetchable.** A client downloads what its queries need, and nothing
  more.
- **Provenance-carrying.** Every depth is attributable to a source and a time.

These are not aspirations — they constrain the schema and the transport, so they
come first.

---

## 2. Data quality

A sounding carries everything needed to judge it. Grouped as the chart world
does.

### 2.1 Provenance — who, when, with what

- **`source`** — the contributing vessel.
- **`time`** — the instant measured; rolled up per tile as `minTime`/`maxTime`.
- **`tecsou`** — technique of sounding (single-beam, crowdsourced,
  satellite-derived), so like can be compared with like.
- **`gnss`** — fix quality at the time (`hdop`, fix type): the raw material for a
  position-quality rating.

### 2.2 Uncertainty

Each sounding carries an error bar in the S-44 form `TVU(d) = sqrt(a² + (b·d)²)`:

- **`hUnc`** — horizontal uncertainty, fixed plus depth-dependent.
- **`vUnc`** — vertical uncertainty from the terms we can actually know (draft,
  sound velocity, calibrated vs uncalibrated sounder).

Per cell, these aggregate **worst-case** — a zone's category is the worst of its
components.

### 2.3 Confidence — CATZOC / ZOC

Confidence is **per area**, not per cell: a **coverage layer** of non-overlapping
quality polygons, each carrying:

- **`zoc`** — zone of confidence (A1…D, U), starting at **D** for crowdsourced
  data until validation supports more;
- **`categoryTemporalVariation`** — stable / unstable / unassessed;
- **`dataAssessment`** — assessed / oceanic / unassessed;
- **`featuresDetected`** and **`fullCoverage`** — set _false_ for inadequately
  surveyed water;
- **`surveyDateRange`** — from/to;
- **`depthRange`** — the `DRVAL1`/`DRVAL2` band the area covers.

### 2.4 Reduction to a common datum

Uncalibrated offsets and uncorrected tide are what put crowdsourced accuracy at C
or D; removing them is the biggest available win. Each sounding therefore carries:

- **`datum`** — the reference it is measured from (`belowTransducer` /
  `belowSurface` / `belowKeel`), per sounding and not per install;
- **`draft`** — so an off-datum sounding reduces to a common reference;
- **`tide`** — the water level above chart datum at that moment, so a set reduces
  toward a chart datum.

### 2.5 The record

The unit of trade is the **sounding**:

```
{
  t:     number,          // instant
  lon:   number,
  lat:   number,
  depth: number,          // as measured
  datum: 'belowTransducer' | 'belowSurface' | 'belowKeel',
  draft?:     number,
  offset?:    { forward: number, starboard: number } | null,
  source:     string,     // contributing vessel
  gnss?:      { hdop?: number, fixType?: string, hAcc?: number },
  tide?:      number,
  tecsou?:    number,
  heading?:   number,
  speed?:     number,
  hUnc?:      number,
  vUnc?:      number
}
```

The derived tile carries the summarised confidence next to the depth:

```
cell = { depthCm, count, bySource: {...}, minTime, maxTime, vUncCm?, zoc? }
```

---

## 3. Sharing

### 3.1 The merge is a CRDT

A cell keeps the **shallowest** depth; merging two stores is `min`, and the
pyramid recomputes from its children. `min` is commutative, associative and
idempotent, so instances **converge regardless of order, with no coordination**.
`count` is not part of that — it is kept **per source** (`bySource`), which is
both what makes it mergeable and what makes a claim checkable.

### 3.2 Sync is Merkle + sparse

The same pyramid is a **Merkle tree**: each tile carries `H(sorted(cell hashes))`,
and a connection compares the coarsest level first, descending only into
differences. Most connections exchange a few dozen hashes and nothing else, and a
query fetches only the blocks it needs.

### 3.3 What replicates

**Raw soundings, one signed append-only feed per vessel**, from which the tiles
are derived as a shared view. This is what makes §2 possible — provenance is per
sounding, and the tiles stay derived.

### 3.4 Peers

Every instance is a server with storage. Sync is **server ↔ server** (and
server ↔ cloud); the browser is a viewport cache.

### 3.5 Stack

**Hypercore + Hyperbee + Autobase/Autobee + Hyperswarm** — chosen because it is a
network _and_ the database:

| Need                                                | Primitive                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sorted keyed map (z,x,y → cells), bbox/zoom queries | **Hyperbee** — a B-tree on a Hypercore; a bbox query is a range scan         |
| Merkle + sparse fetch                               | **Hypercore** — a signed Merkle log with sparse replication                  |
| Integrity                                           | Hypercore's signed Merkle tree                                               |
| Multi-writer merge                                  | **Autobase** + **Autobee**, whose `apply()` is the single ordering authority |
| Discovery, NAT, LAN                                 | **Hyperswarm / HyperDHT** — DHT discovery, UDP hole-punching, LAN-local      |

`apply()` is where **validation lives** — the gate every incoming sounding passes
before it reaches the view. [OpenPact](https://openpact.dev/docs/architecture/)
is a working reference of this architecture.

**libp2p** is the alternative when we need cross-language or browser peers, or to
ride the IPFS DHT — but it gives only the network; the store, the Merkle and the
sparse sync would be ours to build.

### 3.6 Constraints to live with

- **JS-only** on the Holepunch path.
- **CGNAT/Starlink** defeats hole-punching for a tail of pairs — a relay/seed is
  part of the design, not a fallback.
- **Dependency weight** — a real stack inside a Signal K plugin.
- **Autobase only if validation needs ordering.** The `min` merge converges
  without it; it earns its place through validation and membership.

---

## 4. Plan

1. **Prove the merge** — two local stores, whole-tile exchange, confirm
   convergence.
2. **Pin the sounding record (§2.5) and the coverage-layer shape** — before any
   sync ships; the format is a breaking change across peers.
3. **Merkle delta** — per-tile hash and tree walk; measure wire volume.
4. **LAN discovery**, then peer-to-peer exchange with no server.
5. **WAN** — WebRTC/TURN or a relay, with a fallback relay for CGNAT.
6. **Validation** — provenance, cross-checking and CATZOC-style confidence,
   inside `apply()`.

## 5. Open questions

- **Privacy** — syncing publishes a track. Open, opt-in peers, or aggregated?
- **What is a write?** One feed per vessel, or per vessel-and-voyage?
- **Tide source** — where does `tide` come from when a vessel has no tide
  provider, and what do we do when it is unknown?
- **Coverage layer or per-cell flag?** Polygons are what the outline wants; a
  per-cell `zoc` is far cheaper and may be enough for a screen surface.
- **Autobase or plain feeds?** Depends on whether validation is centralised.

## References

- IHO/NOAA standards for crowdsourced bathymetry:
  <https://github.com/openwatersio/crowd-depth/blob/main/docs/plans/global-grid/standards.md>
- Hypercore, Hyperbee, Autobase, Autobee, Hyperswarm — `holepunchto/*`
- OpenPact reference architecture — <https://openpact.dev/docs/architecture/>
- libp2p — `libp2p/js-libp2p`
