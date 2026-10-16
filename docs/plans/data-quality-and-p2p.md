# LiveDepth: data quality and peer-to-peer sync

**Status:** design — nothing here is built. This captures the decisions made
while working out how LiveDepth should describe its own data quality and how
instances should share it.

The goal is a **common bathymetry dataset** assembled from many vessels. Two
questions follow from that: what must the data _carry_ to be trustworthy
(data quality), and how do instances _exchange_ it (peer-to-peer sync). They are
one problem, because the answer to the first is a set of per-sounding
attributes, and that decides what the second replicates.

---

## 1. Where we are

**The store.** A sparse Web-Mercator XYZ tile store (`src/tiles/core/`): level
`z` splits the world into `2^z` tiles of 256×256 cells; a cell is a 5-byte record
`cx, cy, depthCm, count`. A tile holds the **shallowest** depth seen per cell;
coarser levels are the min-pooled parents, so zooming out never deepens a shoal.
It is backed by SQLite in the plugin and mirrored in memory in the browser.

**The pipeline.** The plugin subscribes to the vessel's own
`environment.depth.*` + `navigation.position`, folds each sounding in, and serves
tiles. The chart layer is a plotter extension: a background runtime owns the
soundings and answers the host's frame requests.

**What a cell carries today:** `{ depthCm, count }` — a depth and a sample
count. No provenance, no uncertainty, no datum, no confidence.

---

## 2. Data quality

The IHO/NOAA outline (see _References_) is, read as a schema, a list of
attributes our store lacks. Grouped by what it asks for:

### 2.1 Provenance — who, when, with what

Without per-origin provenance you cannot cross-check a claim ("one vessel says
shallow where ten say deep") or trust anything. Needed:

- **`source`** — the contributing vessel (the Signal K `$source` idiom), and the
  sample count **per source**, not one fused `count` (also what keeps the count
  a mergeable CRDT — see §3).
- **`time`** — the sounding instant; carried into the tile as `minTime`/`maxTime`
  (drives age-based downgrade).
- **`tecsou`** — technique of sounding: single-beam, crowdsourced,
  satellite-derived (S-57 `TECSOU`; the doc restricts SDB to unsurveyed areas,
  `TECSOU 11`).
- **`gnss`** — fix quality at the time (`hdop` / fix type); the raw material for
  `QUAPOS`.

### 2.2 Uncertainty

The doc gives the S-44 form `TVU(d) = sqrt(a² + (b·d)²)` with coefficients per
order. Our depth has no error bar. Needed:

- **`hUnc`** — horizontal uncertainty, fixed + depth-dependent (GNSS fix, plus
  any transducer-offset correction applied).
- **`vUnc`** — vertical uncertainty in the S-44 form; components are the `a`/`b`
  terms plus what we can actually know (draft, sound velocity, calibrated vs
  uncalibrated sounder).

Both live on the **sounding** and aggregate worst-case to the **cell**, per
"a zone's category is the worst of its components".

### 2.3 Confidence — CATZOC / ZOC

This is the structural one: it is **per area, not per cell** — "every area with
depth data must be covered by quality polygons that don't overlap". A comparable
design needs a **separate coverage layer** of non-overlapping polygons, each
carrying:

- **`zoc`** — the zone of confidence (A1…D, U);
- **`categoryTemporalVariation`** — stable / unstable / unassessed;
- **`dataAssessment`** — assessed / oceanic / unassessed;
- **`featuresDetected`** (bool) and **`fullCoverage`** (bool) — set _false_ for
  inadequately surveyed water;
- **`surveyDateRange`** — from/to;
- **`depthRange`** — the `DRVAL1`/`DRVAL2` band.

Crowdsourced data defaults to **CATZOC D** until validation supports more.

### 2.4 Reduction to a common datum — the tide problem

The doc is blunt: "uncalibrated offsets and uncorrected tide put depth accuracy
at C or D." Today the depth is stored **as the source reports it**, tagged only
by its configured path, so a below-keel boat and a below-surface boat are
incomparable. Needed:

- **`datum`** — per sounding (`belowTransducer` / `belowSurface` / `belowKeel`),
  not per install;
- **`draft`** — to reduce an off-datum sounding to a common reference;
- **`tide`** (water level) — so a set can be reduced toward chart datum. This is
  the single biggest accuracy win available to us.

### 2.5 Priority

If the bar is "comparable to the outline" rather than "ENC-conformant":

1. **`datum` + `draft` + `tide`** — without them nothing shared is comparable
   across vessels, and accuracy is stuck at C/D.
2. **`source` + per-source counts + `time`** — enables cross-checking and trust,
   and makes the count a real CRDT.
3. **`hUnc` / `vUnc`** per sounding/cell — "depth ± x" instead of "depth".
4. **The coverage layer** (`zoc` + the four S-101 flags) — the chart-level rigour;
   build it when the shared dataset justifies it.

### 2.6 The v2 sounding record

Provenance, uncertainty and datum are **per-sounding attributes on the
replicated feed** — which is the argument for replicating soundings rather than
tiles (§3), and for pinning the record shape **before any sync ships**.

```
{
  t:     number,          // instant
  lon:   number,
  lat:   number,
  depth: number,          // as measured
  datum: 'belowTransducer' | 'belowSurface' | 'belowKeel',
  draft?:     number,     // to reduce to a common reference
  offset?:    { forward: number, starboard: number } | null,
  source:     string,     // contributing vessel
  gnss?:      { hdop?: number, fixType?: string, hAcc?: number },
  tide?:      number,     // water level above chart datum, if known
  tecsou?:    number,     // technique of sounding
  heading?:   number,
  speed?:     number,
  hUnc?:      number,
  vUnc?:      number
}
```

The derived tile then carries a summarised confidence alongside the depth, not
the raw provenance:

```
cell = { depthCm, count, bySource: {...}, minTime, maxTime, vUncCm?, zoc? }
```

---

## 3. Peer-to-peer sync

### 3.1 The store is already a CRDT

A cell keeps the **shallowest** depth; merging two stores is `min` per cell, and
the pyramid is recomputed from its children. `min` is commutative, associative
and idempotent — so peers **converge regardless of exchange order, with no
coordination and no conflicts**. That is the hard half of convergence, already
solved by the format.

**Caveat:** `count` is not a CRDT — summing fuses double-counts. Make it
per-source (`bySource`) or drop it on the wire.

### 3.2 Sync shape: Merkle + sparse

Per-tile hashes and "exchange the summary, pull the deltas" is the right shape,
but a parent's _pooled content_ hash does not bind its children (a child can
change without moving the parent's min). Use a real **Merkle hash per tile** —
`H(sorted(cell hashes))` — and the pyramid supplies the tree shape: compare the
coarsest level, descend only into differences. Most connections then transfer a
few dozen hashes and nothing else.

### 3.3 What a peer is

The **plugin** owns the SQLite store; the browser is a viewport cache. So this is
**server ↔ server** (and server ↔ cloud), not browser ↔ browser — no WebRTC in
the plotter, and a Node host with real storage on both ends.

### 3.4 Stack — recommendation: Holepunch

**Hypercore + Hyperbee + Autobase/Autobee + Hyperswarm** over libp2p, because
libp2p gives a _network_ while Holepunch gives a network **and the database**:

| Need                             | Holepunch                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sorted keyed map (z,x,y → cells) | **Hyperbee** — a B-tree on a Hypercore; a bbox/zoom query is a range scan                         |
| Hash-delta / Merkle              | **Built in** — signed Merkle log with **sparse replication**: fetch only the blocks a query needs |
| Integrity                        | Hypercore's signed Merkle tree — tampering is detectable                                          |
| Multi-writer merge               | **Autobase** (causal DAG → deterministic order) with **Autobee**, a multi-writer KV store         |
| Discovery + NAT + LAN            | **Hyperswarm / HyperDHT** — DHT discovery, UDP hole-punching, LAN-local                           |

Autobase's `apply()` is _the single ordering authority — the only place entries
are validated_: the hook for the data-quality gate. The **OpenPact** project is a
working template of exactly this architecture.

**When libp2p instead:** cross-language (non-JS) peers, browser peers
(WebRTC/WebTransport), or riding the IPFS DHT. It is the safer, more conventional
network — but you build the store, the Merkle and the sparse sync yourself.

### 3.5 Replicate soundings, not tiles

Replicate each vessel's **raw soundings** (one Hypercore per vessel, signed,
append-only) and derive the tiles as a **Hyperbee view** in `apply()`. This is
what makes §2 possible: provenance is per sounding, validation happens in
`apply()`, and the tiles stay derived.

### 3.6 Caveats

- **JS-only** (fine for a Node plugin; not cross-language).
- **Smaller community** than libp2p, though a coherent stack.
- **CGNAT/Starlink is hard for everyone** — expect to run a relay/seed for the
  tail (OpenPact's bootstrap + seed model).
- **Dependency weight** — a real stack to pull into a Signal K plugin.
- **Autobase may be unnecessary.** The `min` merge converges without ordering;
  Autobase earns its place only because _validation_ is order-sensitive and you
  need **membership**. Without validation, N plain Hypercores merged by `min`
  would do.

---

## 4. Plan

1. **Prove the merge** — two local stores, whole-tile exchange over HTTP, confirm
   convergence. Cheap, and it validates the CRDT claim.
2. **Pin the v2 sounding record** (§2.6) and the coverage-layer shape — **before
   any sync ships**, since the format is a breaking change across peers.
3. **Merkle delta** — per-tile hash + tree walk; measure wire volume on a real
   boat's store.
4. **LAN discovery** — then peer-to-peer exchange, no server.
5. **WAN** — WebRTC/TURN or a relay, plus a fallback relay (CGNAT).
6. **Validation layer** — provenance, cross-checking, CATZOC-style confidence,
   living in `apply()`.

## 5. Open questions

- **Privacy.** Syncing publishes your track. Open, opt-in peers, or aggregated?
  Decide before the format ossifies.
- **What is a write?** One feed per vessel, or per vessel-and-voyage?
- **Tide source.** Where does `tide` come from when the server has no tide
  provider, and what do we do when it is unknown?
- **Coverage layer or per-cell flag?** The outline wants polygons; a per-cell
  `zoc` is far cheaper and possibly enough for a screen layer.
- **Autobase or plain feeds?** Depends on whether validation is centralised.

## References

- IHO/NOAA standards as applied to the Crowd-Depth global grid:
  `openwatersio/crowd-depth` — `docs/plans/global-grid/standards.md`
  (CATZOC, S-44 survey orders, S-4 derivation, S-57/S-101 encoding).
- Hypercore, Hyperbee, Autobase, Autobee, Hyperswarm — `holepunchto/*`.
- OpenPact — a reference architecture on the above
  (<https://openpact.dev/docs/architecture/>).
- libp2p — `libp2p/js-libp2p` (the network-only alternative).
