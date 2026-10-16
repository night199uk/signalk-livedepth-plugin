# LiveDepth sync — v1 design

**Status:** draft for decision. The concepts are settled in
[data quality and peer-to-peer sync](data-quality-and-p2p.md); this is the
concrete design — **what to build**. Where this doc is silent, that doc is the
rationale.

---

## 0. Decisions this needs from you

Four, before the rest can be pinned. Everything below is written to hold whichever
way they go, but each changes code.

### D1 — Stack

| Option                                              | Gives                                                   | Costs                                                       |
| --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| **Hypercore + Autobase + Hyperswarm** (recommended) | A signed, sparse, queryable store _and_ discovery/NAT   | JS-only, smaller ecosystem, a real dependency               |
| Plain Hypercores, one per vessel                    | No Autobase determinism burden; merge by `min` directly | Membership and ordered validation become ours to build      |
| libp2p                                              | The network (cross-language, browser peers)             | The store, the Merkle and the sparse sync are ours to build |

### D2 — Identity and membership

Who may write to the shared view?

- **Signed membership** (a pact; writers admitted by an existing member) — bounds
  the Sybil surface, enables a durable source id, costs an admin path.
- **Open writes** — frictionless, but §4.3's Sybil machinery becomes load-bearing.

### D3 — Privacy

- **Open** — every track published.
- **Opt-in peers** — you federate with chosen boats.
- **Aggregated** — only derived tiles leave the boat, never raw soundings.

This one is a product call, and it decides whether D2 can be simple.

### D4 — v1 scope

- **A. Local-first** — formats, local store, merge and confidence, no network.
  Useful on one boat; the network layers on without a format change.
- **B. Network from day one.**

**Recommendation: D1 = Hypercore+Autobase, D2 = signed membership, D4 = A first.**
D3 is yours.

---

## 1. Architecture

```
  sensors ──► Resolver ──► Merger ──► Local store ──► Reader ──► chart layer
   (SK)                     │            │
                            │            └──► Sync ◄──► peers / seed
                            └──► Validator
```

- **Resolver** — turns a raw `environment.depth.*` + position + GNSS + tide into
  the canonical sounding (below surface, §2 of the other doc).
- **Merger** — folds a sounding into its tile: the cell `min`, the per-source
  summary, the recomputed confidence. Deterministic.
- **Local store** — the tiles (replicated), the raw log (audit), the profiles.
- **Reader** — serves the plotter extension from the tiles.
- **Validator** — the per-source summary and the band, plus the local reputation.
- **Sync** — discovery, Merkle compare, sparse fetch, merge.

## 2. The sounding record

One row in the local log; one block on the wire. Packed little-endian:

| Field              | Type   | Notes                                           |
| ------------------ | ------ | ----------------------------------------------- |
| `t`                | u32    | unix seconds                                    |
| `lon`, `lat`       | i32 ×2 | fixed-point, 1e-7° (~1 cm)                      |
| `depthCm`          | u16    | below surface, ≤655 m                           |
| `flags`            | u8     | datum (2 bits), tecsou (4 bits), has-* (2 bits) |
| `sourceId`         | u16    | index into the source table                     |
| `profileId`        | u16    | index into the profile table                    |
| `methodQuality`    | u8     | GNSS fix class                                  |
| `hdop`             | u8     | ×10                                             |
| `hAccCm`           | u16    | horizontal accuracy, cm                         |
| `haeCm`            | i32?   | ellipsoid height, cm; present iff flagged       |
| `tideCm`           | i16?   | above chart datum, cm; present iff flagged      |
| `hUncCm`, `vUncCm` | u16 ×2 | S-44 uncertainties                              |

≈ **32 bytes**. `sourceId` and `profileId` index tables the feed carries; they are
what keep the record small (§2.6 of the other doc).

## 3. The tile bundle

The unit that replicates — a Hyperbee value under key `z/x/y`.

```
tile = {
  v: 1,                      // format version
  cells: [ Cell ],           // sparse, row-major, as today
  sources: [ SourceRef ],    // the source table this tile references
  profiles: [ Profile ],     // the profile table this tile references
  band: u8,                  // CATZOC-style confidence (§4.4)
  updated: u32
}

Cell = {
  key: u16,                  // cy * 256 + cx
  depthCm: u16,              // the minimum
  count: u16,
  band: u8,                  // this cell's confidence
  bySource: [ { idx: u16, count: u16, minCm: u16, worstHAccCm: u16,
                firstT: u32, lastT: u32 } ],
  variability: u8            // 0 stable … 3 unstable (§4.5 of the other doc)
}
```

Two properties matter and are the reason for the shape: `bySource` is **one record
per contributor, not per sounding**, so a cell is bounded by its sources; and the
whole bundle is **self-contained**, so confidence is a pure function of it and a
peer that fetches it can both draw and judge it.

## 4. Flows

### 4.1 Ingest (live)

1. The collector pairs a depth with the latest position, heading and GNSS and
   resolves the tide (Resolver, §1).
2. The resolver reduces to below surface using the profile in force, and emits a
   sounding.
3. The sounding is appended to the raw log.
4. The merger folds it into its tile (§4.2).

### 4.2 Merge (deterministic)

For each affected tile and cell:

1. if `depthCm < cell.depthCm`, replace it (the `min` — the safety rule);
2. update the source's `bySource` entry (`count++`, `min`, `worst`, `lastT`);
3. recompute the cell's `band` and the tile's `band`;
4. if `depthCm` changed, rebuild the tile's ancestors (the min-pool pyramid).

This is the CRDT join: commutative, associative, idempotent. Two peers that have
seen the same soundings hold byte-identical tiles.

### 4.3 Sync

1. **Discover** — Hyperswarm on a topic (LAN-local first, DHT for WAN).
2. **Compare** — exchange the coarse-level tile hashes (the pyramid is the Merkle
   tree); descend only into differences.
3. **Fetch** — pull the differing tiles; a reader fetches only the tiles in its
   view.
4. **Merge** — fold each into the local store (§4.2).

Raw soundings are **not** in this flow. They are fetched separately, on demand, by
a peer that wants to audit or re-derive.

### 4.4 Validate

Per tile, from its own bundle:

1. count **independent** sources agreeing within tolerance (distinct vessel,
   distinct method, not near-simultaneous duplicates);
2. weight by nominal accuracy, decay by age, damp by `variability`;
3. collapse to the band.

Nothing here reads anything outside the tile. The reputation (§5) refines it
locally, and is not stored.

## 5. Local reputation (v1)

Derived, never voted:

- **hit rate** — the fraction of a source's contributions within tolerance of the
  instant's consensus;
- **bias** — its consistent offset, which _corrects_ rather than discards a
  miscalibrated boat.

Computed per peer from the tiles it holds, applied as a weight when a reader
renders a band. Not shared, not stored in the tile — which keeps the tile's band
deterministic (§4.7 of the other doc).

## 6. Phasing

| Phase | Scope                                        | Ships                         |
| ----- | -------------------------------------------- | ----------------------------- |
| **0** | Formats §2–§3, local store, resolver, merger | A single boat's tiles, richer |
| **1** | Confidence bands (§4.4)                      | Trust visible on one boat     |
| **2** | LAN discovery + tile exchange (§4.3)         | Two boats in the same marina  |
| **3** | WAN + seed (§4.3)                            | Federated                     |
| **4** | Reputation (§5)                              | Weighted trust                |

Phase 0 is where the **format decision must be right** — it is a breaking change
across peers forever after.

## 7. Deferred to calibration

Not design gaps; they need real data:

- the agreement **tolerance**;
- the **counts** that promote a band;
- the **decay** rates, and how `variability` scales them;
- the reputation's **prior** and learning rate.

## 8. Risks

- **The stack assumptions.** Sparse fetch, `apply()` determinism and Hyperswarm
  NAT are all unvalidated here. **Spike first** (below).
- **The raw log's growth** — the one unbounded axis; a retention policy is a
  v1 decision (keep all / rolling window).
- **Privacy** — D3 gates D2 and what replicates.

### The spike

Before Phase 0 hardens: two local stores, one real boat's tile set, replicate over
a local swarm, and measure (a) the wire volume for a Merkle delta, (b) the `apply()`
cost at realistic tile counts, (c) that a sparse fetch returns exactly the queried
range. Everything in §3–§4 assumes those three hold.

## References

- [Data quality and peer-to-peer sync](data-quality-and-p2p.md) — the rationale.
- IHO/NOAA standards for crowdsourced bathymetry — see that doc's references.
- Hypercore, Hyperbee, Autobase, Hyperswarm — `holepunchto/*`.
