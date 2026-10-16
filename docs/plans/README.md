# LiveDepth — design plans

Two documents, in reading order:

| Doc                                                  | What                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`data-quality-and-p2p.md`](data-quality-and-p2p.md) | The rationale: a shared bathymetry dataset, its data quality against the IHO/NOAA outline, and peer-to-peer sharing. |
| [`v1-design.md`](v1-design.md)                       | The concrete design — what to build.                                                                                 |

**Scope note.** The transport and sync are expected to come from a separate,
general-purpose project (`signalk-p2p`) whose goals reach beyond bathymetry.
These docs describe the **data** and the **requirements it places on a channel** —
not an implementation of the channel, or of the network it runs on.

**Status:** concepts settled, concrete design drafted, awaiting four decisions.
Nothing is built; no wire or tile format is frozen.

**Reviewing this?** Read **`v1-design.md` §0 first** — it is what the design is
waiting on: the stack, identity and membership, privacy, and v1 scope. Then §1–§5
for the shape, §6 for the phasing, §7 for what is deliberately deferred to
calibration, and §8 for the open engineering risks (chief among them the spike
that would validate the stack assumptions before any format is frozen). Dip into
the rationale — §2 (quality) and §4 (validation) especially — for the _why_ behind
each choice.
