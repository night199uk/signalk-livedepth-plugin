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
- **`gnss`** — fix quality at the time: the fix class
  (`navigation.gnss.methodQuality`), the dilution of precision
  (`horizontalDilution` / `verticalDilution`), and the **horizontal accuracy in
  metres**. The last varies fix to fix, so it is recorded per sounding; it is
  what feeds `hUnc` (§2.2). Signal K has no single accuracy field in its core
  `navigation.gnss` set, but implementations commonly publish
  `navigation.gnss.horizontalAccuracy` (the schema is open — `[k: string]:
unknown`); where it is absent, derive it from the DOP and the fix class
  (RTK-fixed ≈ cm, RTK-float ≈ dm, autonomous ≈ m).

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

### 2.4 The stored datum and the offset profile

**Depth is always stored below surface.** It is the one datum every boat can
agree on, and it makes the shared dataset comparable — a below-keel boat and a
below-transducer boat contribute the same units. The plugin reduces on write:
`derived-data` synthesises `belowSurface` from whichever of the transducer offset
or the draft the vessel has configured, and the plugin **refuses in the schema,
with a message to the user,** when neither is available and the datum cannot be
resolved.

**The offsets travel as a versioned profile**, not on every sounding. A profile
is the vessel's geometry over a span of time:

```
profile = { from, to, transducerOffsetCm, draftCm }
```

`transducerOffsetCm` is the surface→transducer distance; `draftCm` is the
surface→keel distance. Loading changes the draft and re-rigging changes the
transducer, so each closes one profile and opens another. **Profiles never
overlap in time** — exactly one is in force at any instant.

**A sounding references its profile** — an id, or nothing at all when its `time`
already resolves the profile in force — so the per-sounding cost of the offsets
is a few bits at most, against the two bytes a raw pair on every point would cost
(§2.6). The profile belongs to the vessel's feed and replicates with it.

**The other datums are derived at display,** by static subtraction:

```
belowTransducer = belowSurface − transducerOffset
belowKeel       = belowSurface − draft
chartDatum      = belowSurface − tide
ellipsoidDepth  = waterSurfaceHAE − belowSurface
```

The first two are pure geometry and exact for the profile in force. The third is
the only one that depends on knowing the tide, and is the difference between
CATZOC C/D and something better.

**Where the receiver provides it, we also carry the ellipsoidal height** — the one
reference that is global, computable and time-stable, and the direction the IHO
is moving (VORF, Bathyelli tie chart datum to the GRS80 ellipsoid). Signal K
carries the pieces already: `navigation.gnss.antennaAltitude` (height above the
geoid) and `navigation.gnss.geoidalSeparation` give the antenna's height above
the ellipsoid, `h = altitude + separation`. It is **conditional** — some receivers
emit a zero or omitted separation — so the field is optional, and it is a
_reference_, not datum-grade: the GNSS vertical is markedly noisier than the
horizontal, and the antenna sits above the transducer by a lever arm that would
have to be subtracted.

### 2.5 The record

The unit of trade is the **sounding**: depth below surface, with a reference to
the offset profile in force.

```
{
  t:        number,   // instant
  lon:      number,
  lat:      number,
  depth:    number,   // below surface — the canonical datum
  source:   string,   // contributing vessel
  profile?: string,   // offset profile in force; omit when `t` resolves it
  gnss?:    { hdop?: number, fixType?: string, hAcc?: number },
  hae?:     number,   // antenna height above the ellipsoid, when the GNSS gives it
  tide?:    number,   // water level above chart datum at `t`, when known
  tecsou?:  number,
  heading?: number,
  speed?:   number,
  hUnc?:    number,
  vUnc?:    number
}
```

The derived tile carries the summarised confidence next to the depth:

```
cell = { depthCm, count, bySource: {...}, minTime, maxTime, vUncCm?, zoc? }
```

### 2.6 Why the profile, in bytes

The offset is a small, unsigned, hull-scale quantity, so a single byte holds
either value with room to spare:

| Max offset     | Precision | Values | Bits |
| -------------- | --------- | ------ | ---- |
| 10 ft (3.05 m) | 1 cm      | 305    | 9    |
| 8 ft (2.44 m)  | 1 cm      | 244    | 8    |
| 10 m           | 5 cm      | 200    | 8    |
| 10 ft (3.05 m) | 5 cm      | 61     | 6    |

Stored raw on every sounding, the pair would cost 2 bytes (1 cm, ≤8 ft) to 2.25
bytes packed (9 bits each) — as much as the depth itself (uint16 cm). As a
versioned profile it costs two bytes **once per voyage**, and the soundings carry
only a reference to it.

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

**Raw soundings, one signed append-only feed per vessel — each reduced to depth
below surface (§2.4) — plus that vessel's offset profiles.** The tiles are
derived from those as a shared view. This is what makes §2 possible: every
sounding arrives in one datum, so peers are directly comparable; provenance is
per sounding; and the tiles stay derived.

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

`apply()` is where the **merge** lives — the deterministic reduction of each
writer's soundings into the shared view, computed identically on every peer. It is
deliberately _not_ where trust is assessed: confidence depends on which peers a
reader has fetched, so it is a reader-side overlay (§4), not shared state.
[OpenPact](https://openpact.dev/docs/architecture/) is a working reference of this
architecture.

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

## 4. Validation and confidence

The data cannot tell us what is true; trust has to be derived. The value we chart
stays the **minimum** — the safety rule, never deeper than a report — and the
**confidence** is a separate output that says how much to believe it.

### 4.1 Two questions, not one

- **Is the measurement good?** Self-declared: the fix class and accuracy, whether
  the sounder is calibrated, whether the datum and offset were known. A _nominal_
  uncertainty, and spoofable — a bad boat can claim RTK. Necessary, not
  sufficient.
- **Is the claim good?** Verified: do _independent_ sources, over time, agree? A
  property of the _set_, not of the sounding, so it cannot be self-declared.

### 4.2 The factors

- **Agreement** — how many independent sources land within tolerance at a cell.
- **Independence** — the crux (§4.3).
- **Age** — the seabed moves; the standard's _temporal variation_.
- **Nominal quality** — the first question, as a weight.

### 4.3 Independence

"Ten boats agree" is worthless if they are not ten independent observations.

- **Common-mode error** — ten boats sharing a wrong datum, tide model or sounder
  all agree _and are all wrong_. Independence must include the **method** (the
  datum source, the tide source, `tecsou`), not just the vessel.
- **Collusion / Sybil** — one operator standing up ten fake vessels. Not solvable
  without identity, but make it _costly_: weight agreement by a source's **tenure
  and volume**, and treat a burst from a young, single-purpose source as
  low-weight.
- **Double-counting** — the same pass replayed. The **time** dimension catches it:
  near-simultaneous, near-identical fixes from one source are one observation.

### 4.4 The safety/outlier split

A single false shallow reading (a fish, a bubble, a transducer fault) would
otherwise own a cell forever. Resolve it by keeping the two outputs apart:

> **Keep the shallow value; do not grant it confidence.**

A shoal only one source reports, and nothing reproduces, is charted as a
**doubtful sounding** — shown (safety) and marked (trust). That is what charts
already do, and what the standard's `featuresDetected` and caution-note machinery
expresses.

### 4.5 Reputation

A _shared_ reputation — everyone agrees a boat is good — needs attestations (one
peer's signed judgement of another's data), which is a consensus problem in
disguise. Start with **local** reputation: each peer cross-validates against what
it has fetched and weights sources accordingly. No coordination, no consensus; two
peers may disagree about a boat, which is fine, because confidence is a display
property, not shared state.

### 4.6 Where it runs

- **Shared and deterministic:** the merge — `min` plus the per-source summary.
  Every peer converges on it.
- **Local overlay:** the confidence. It depends on what the reader has fetched, is
  non-deterministic by nature, and **must not live in `apply()`** — a shared view
  that differed per peer would break convergence.

### 4.7 Confidence v1

Count _independent_ sources (distinct vessel, distinct method, not
near-simultaneous duplicates) agreeing within tolerance; grow confidence with
their count and their worst nominal accuracy, and decay it with age; collapse it
to a **CATZOC-style band** — `D` unconfirmed → `C` single confirmed → `B`
corroborated — because that is the vocabulary charts and users already speak.

**Caveat:** this verifies **consensus, not truth** — ten boats can agree on
something false. Consensus, independence and provenance are the strongest signals
a crowd offers, and they are exactly what CATZOC was built to express.

---

## 5. Storage

Three kinds of thing, with very different growth, kept apart.

### 5.1 Soundings — the raw record (per vessel)

One row per sounding, the §2.5 record, held **on the vessel that collected it**.
It is the source of truth and the unit that _replicates sparsely_ (§3.3) — it is
not copied to every peer.

```
soundings(
  t              INTEGER,  -- unix ms
  source         TEXT,     -- vessel id
  lon, lat       REAL,     -- WGS84
  depth          REAL,     -- below surface (canonical, §2.4)
  profile        INTEGER,  -- FK -> profiles
  method_quality INTEGER,  -- GNSS fix class
  hdop           REAL,
  h_acc          REAL,     -- horizontal accuracy, m
  hae            REAL,     -- antenna height above ellipsoid, when given
  tide           REAL,     -- water level above chart datum, when known
  tecsou         INTEGER,
  heading        REAL,
  speed          REAL,
  h_unc          REAL,
  v_unc          REAL
)
```

**Growth: the one unbounded axis** — roughly 0.6–2 MB/hour, hundreds of MB a year,
GBs if the sounder runs continuously. Bounded _per vessel_, which is what makes
sparse replication viable. Retention is the operator's call: keep it all, or roll
a window and let the derived store be the durable artifact.

### 5.2 Tiles — the derived index (replicated)

The sparse Web-Mercator store, and the thing that actually replicates between
peers — **bounded by the geography sailed**, not by time. A tile's cells carry the
summarised provenance and confidence beside the depth:

```
cell = { cx, cy, depthCm, count, bySource, hAccCm?, minTime, maxTime, band? }
```

- `depthCm` — the minimum (the charted value).
- `bySource` — a small map of source → { count, worst `h_acc` } — the provenance a
  reader needs to cross-validate without the raw.
- `minTime` / `maxTime` — the age.
- `band` — the CATZOC-style confidence (§4.7).

This summary is what keeps provenance _bounded_: a cell's contributors do not grow
the way a sample log does.

### 5.3 Profiles — the offset geometry (per vessel)

Versioned, non-overlapping spans (§2.4):

```
profiles(
  id                   INTEGER PRIMARY KEY,
  source               TEXT,
  from_t, to_t         INTEGER,  -- the span this geometry was in force
  transducer_offset_cm REAL,
  draft_cm             REAL
)
```

Tiny, and it replicates because a sounding's reduction depends on it.

### 5.4 Deliberately not stored

- **A fleet-wide sounding replica.** The raw stays on its origin and is fetched
  sparsely; the replicated index is the tiles (§5.2).
- **The tide as a per-sounding column, in the common case.** It is a smooth
  function of position and time, so a per-voyage series (or a resolver) is
  cheaper; record it per sounding only where the source gives it directly.

---

## 6. Plan

1. **Prove the merge** — two local stores, whole-tile exchange, confirm
   convergence.
2. **Pin the sounding record (§2.5), the cell summary (§5.2) and the profile
   (§5.3)** — before any sync ships; the format is a breaking change across peers.
3. **Merkle delta** — per-tile hash and tree walk; measure wire volume.
4. **LAN discovery**, then sparse peer-to-peer exchange with no server.
5. **WAN** — WebRTC/TURN or a relay, with a fallback relay for CGNAT.
6. **Validation** — the confidence overlay (§4.7) at the reader, over the
   per-source summary.

## 7. Open questions

- **Privacy** — syncing publishes a track. Open, opt-in peers, or aggregated?
- **What is a write?** One feed per vessel, or per vessel-and-voyage?
- **Tide source** — where does `tide` come from when a vessel has no tide
  provider, and what do we do when it is unknown?
- **Coverage layer or per-cell band?** Polygons are what the outline wants; a
  per-cell band (§5.2) is far cheaper and may be enough for a screen surface.
- **Raw retention** — keep the origin's sounding log forever, or a rolling
  window, with the derived store durable?
- **Band thresholds** — the agreement tolerance and the count that promotes a cell
  from `C` to `B` need calibration against real data.

## References

- IHO/NOAA standards for crowdsourced bathymetry:
  <https://github.com/openwatersio/crowd-depth/blob/main/docs/plans/global-grid/standards.md>
- Hypercore, Hyperbee, Autobase, Autobee, Hyperswarm — `holepunchto/*`
- OpenPact reference architecture — <https://openpact.dev/docs/architecture/>
- libp2p — `libp2p/js-libp2p`
