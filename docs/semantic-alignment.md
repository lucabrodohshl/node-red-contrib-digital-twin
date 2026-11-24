# Semantic alignment of digital twins and physical twins

This fork extends the semantic DT modelling nodes of
[node-red-contrib-digital-twin](https://github.com/steinmetz/node-red-contrib-digital-twin)
with a formally checked notion of **semantic alignment** between a Digital Twin (DT) model and
its Physical Twin (PT).

The original nodes give a DT a shared **vocabulary**: assets, properties, actions, events and
relations, annotated with ontology types (e.g. SAREF) and stored in a knowledge graph. A shared
vocabulary does not guarantee that the DT *behaves* like the PT. A DT's `lowBattery` event and
the flight controller's `bat_low!` signal can carry the same SAREF type and still fire at
different thresholds. A DT can also promise that a field cell is sprayed within 40 s when the
real drone always finishes within 30 s. Neither mismatch shows up in the knowledge graph.

The extension makes this checkable. Each time you deploy, it asks:

> Is every behaviour of the DT realisable by the PT, and vice versa, once both are read through
> a shared ontology?

The answer is a verdict (**strong**, **weak** or **none**). When the twins are misaligned, it
comes with a **witness**: a timed trace, a clock valuation and, for semantic mismatches, an
SMT countermodel over the ontology.

---

## 1. Concepts

### 1.1 Views

Both twins are abstracted as **timed automata** (clock-only, diagonal-free):

* **PT view**: an authoritative model owned by the PT engineers, e.g. a UPPAAL model of the
  controller. It uses the PT's own vocabulary (`bat_low!`, `SPRAYING`, ...).
* **DT view**: produced automatically from the Node-RED flow (see §3, *lifting*). It uses the
  DT's vocabulary (`lowBattery`, `Spraying`, ...).

Locations carry **atomic propositions** (`airborne`, `spraying`) and may have upper-bound
invariants (`x <= 30`). Edges carry an **event label**, a clock guard (`x >= 10`) and clock
resets. A label that is empty or `tau` is an internal step.

### 1.2 Shared ontology

The only artefact the two twins share is an ontology **K = (S, F, R, Δ)**:

| Part | Meaning | Example |
|------|---------|---------|
| `S` sorts | value domains (Real by default, or Int/Bool) | `sort Energy` |
| `F` functions | domain quantities | `fun soc : Energy` |
| `R` relations | Boolean domain facts | `rel armed :` |
| `Δ` axioms | domain laws (SMT-LIB2) | `axiom reserve : (= soc_rtb 25)` |

### 1.3 Interpretations

Each twin has an **interpretation** `I : AP ∪ Σ → L(K) ∪ {τ}`. It maps every proposition and
event label to a quantifier-free formula over K, or to `τ` (internal, unobservable).

```text
; PT interpretation                 ; DT interpretation (lifted from the flow)
bat_low!     : (< soc soc_rtb)      lowBattery   : (< soc 25)
start_spray! : (and (> alt 0)       sprayStarted : (> flow 0)
                    (> flow 0))
spraying     : (> flow 0)           dispensing   : (> flow 0)
nozzle_check : tau                  logTelemetry : tau
```

### 1.4 Domain equivalence

A PT label `a` and a DT label `b` are **domain-equivalent** when `Δ ⊨ I_P(a) ↔ I_D(b)`. The
check is a single unsatisfiability query to z3.

In the example, `start_spray!` and `sprayStarted` are syntactically different formulas. They
are still domain-equivalent, because the axiom `(=> (> flow 0) (> alt 0))` (no spraying on the
ground) makes `alt > 0` redundant. `bat_low!` and `lowBattery` are equivalent because
`Δ ⊨ soc_rtb = 25`.

Purely syntactic matching (`--syntactic`) aligns nothing here: no label names coincide.

### 1.5 Alignment

**Strong alignment** is a *weak timed bisimulation modulo domain equivalence*. A relation `R`
between PT and DT states (location + clock valuation) is an alignment if, for every
`(p, d) ∈ R`:

| | Condition |
|---|---|
| **I** state consistency | `p` and `d` agree on the domain meaning of their propositions (same set of domain-equivalence classes) |
| **II** PT → DT events | every observable PT move `p –a→ p'` is matched by `d –τ*·b→ d'` with `a ≡ b` and `(p', d') ∈ R` |
| **III** DT → PT events | symmetrically, every observable DT move is matched by the PT |
| **IV** delays | a delay `p –δ→ p'` is matched by `d –δ→ d'`, and vice versa |

Internal (τ) moves on one side may be matched by staying put or by up to `maxTau` internal
steps on the other.

**Weak alignment** keeps only the PT → DT direction (I, II and PT → DT IV). The DT then
reproduces every PT behaviour but may also contain behaviour the PT cannot exhibit.

| Level | What it licenses |
|-------|------------------|
| **strong** | prediction, optimisation, what-if analysis: every DT trajectory is realisable by the PT |
| **weak** | monitoring: every PT trajectory has a DT counterpart, so the DT can follow the PT |
| **none** | nothing; a witness explains why |

**Bisimulation-critical events** (`D_safe`, e.g. `bat_low!`) must have *exactly one*
domain-equivalent DT event. This rules out a DT that is aligned only because several of its
events happen to cover a safety-relevant PT event.

### 1.6 Knowledge refinement (ontology evolution)

Ontologies evolve: new regulations, new sensors, updated manuals. A new domain knowledge
`Φ' = (K', I_P', I_D')` **refines** the old one `Φ`, written `Φ' ⊑ Φ`, when:

* **(a)** `K'` keeps every sort and symbol of `K`, with the same signature;
* **(b)** the new axioms entail the old ones: `Δ' ⊨ Δ`;
* **(c)** every label keeps its meaning (`Δ' ⊨ I'(x) ↔ I(x)`) and its internal/observable status.

If `Φ' ⊑ Φ` and the views have not changed, an alignment established under `Φ` still holds
under `Φ'`. `dt-alignment` then reuses the verdict instead of re-running the full check, and
the node status shows `(reused: K′⊑K)`.

Example: adding wind limits (`examples/drone/drone_v2_wind.ont`) is a refinement, so the
verdict is reused. Raising the return-to-base reserve from 25 % to 30 %
(`drone_v2_reserve.ont`) violates (b). The full check then runs and reports that the DT's
literal `(< soc 25)` no longer matches `bat_low!`. If the DT had written `(< soc soc_rtb)`, it
would remain aligned.

---

## 2. Algorithm

The engine lives in `src/alignment/` (TypeScript, compiled to the `.js` files next to it):

1. **Label equivalence.** Compute the domain-equivalence relation `E ⊆ Σ_P × Σ_D` and the
   proposition classes with one batched z3 call. Pairs that are not equivalent keep a
   countermodel for the witness.
2. **Criticality and saturation.** Check that each critical PT event has exactly one partner
   and that every observable label of each twin has a partner (strong mode).
3. **Product zone graph.** Explore the product of the PT and DT automata over the union of
   their clocks, so delays elapse jointly. Zones are DBMs with max-constant extrapolation.
   Clocks that are always reset before being read again are freed (active-clock reduction).
4. **Matching.** For each product node, a move of one side is matched if the zones of the
   matching moves of the other side (after at most `maxTau` τ-steps) **cover** the source
   zone exactly (federation subtraction). Delays are matched by comparing invariant
   boundaries.
5. **Greatest fixpoint.** Repeatedly drop unmatched nodes. The twins are aligned if the
   initial node survives.
6. **Witness.** If the initial node is dropped, report the shortest trace to the first failure
   with its clock valuation and the responsible countermodels.

The result is a sound under-approximation of the greatest alignment relation. An *aligned*
verdict is a proof. A *misaligned* verdict always comes with a witness that can be inspected.

| File | Contents |
|------|----------|
| `dbm.ts` | difference-bound matrices: canonical form, intersection, up/reset, extrapolation, subtraction (federations) |
| `ta.ts` | timed automata, JSON format, UPPAAL XML import, composition |
| `smt.ts` | batched z3 process, SMT-LIB tokenising |
| `ontology.ts` | ontology and interpretation parsers, SMT preamble |
| `checker.ts` | the alignment check above |
| `refinement.ts` | knowledge refinement (a)–(c) |
| `lifting.ts` | Node-RED flow → DT view + DT interpretation |
| `native.ts` | optional delegation to an external `run_all_semantic` checker binary |
| `cli.ts` | command-line front end (`dt-align`) |

---

## 3. Modelling in Node-RED

### 3.1 Nodes

| Node | Kind | Configuration |
|------|------|---------------|
| `dt-property` | extended | **Ontology term**: the K-term this property denotes, e.g. `battery` ↦ `soc`. Property names can then be used in every formula of the same asset. |
| `dt-action`, `dt-event` | extended | **Interpretation**: SMT-LIB formula over K and the asset's property names. Empty = internal (τ). |
| `dt-behavior` | new | **Behaviour**: timed automaton (JSON, §4.1) whose edge labels are the asset's action/event names. **Propositions**: `name : formula` lines. Wire the asset to it like a property. |
| `dt-ontology` | new, config | ontology text (§4.2) and a **version** |
| `dt-pt-view` | new, config | PT model (JSON or UPPAAL XML, optional template name), PT interpretation (§4.3), critical events |
| `dt-alignment` | new | asset (name or id), ontology, PT view, `maxTau`, optional z3 path |
| `dt-align-gate` | new | the `dt-alignment` node to consult, required level (strong/weak) |

Flows built with the original package load and behave unchanged. All new fields are optional.

### 3.2 Lifting

When `dt-alignment` runs, `liftAsset` collects the nodes wired to the asset (using the same
convention as `dt-graph`):

* the `dt-behavior` becomes the DT view (exactly one is required per checked asset);
* every `dt-action`/`dt-event` contributes its interpretation, with property names replaced by
  their bindings (`(< battery 25)` → `(< soc 25)`);
* behaviour labels that are not actions/events of the asset (e.g. `logTelemetry`,
  `optimizeRoute`) become internal steps;
* propositions are translated the same way.

The lifting reports warnings, for example for an action without an interpretation, in
`msg.payload.warnings`.

### 3.3 `dt-alignment`

It runs automatically about 100 ms after every deploy, and again on every input message.

* If the PT view and DT model are unchanged and only the ontology changed, it first checks
  knowledge refinement against the last certified snapshot and reuses the verdict if
  refinement holds.
* Otherwise it checks strong alignment and, if that fails, weak alignment.
* **What-if:** a message with `msg.payload.behavior` (a candidate `dt-behavior` JSON) is
  checked *instead of* the deployed behaviour. The published verdict and the knowledge graph
  are left untouched. Use this to vet a DT update or self-adaptation before deploying it.

Node status: green *strongly aligned*, yellow *weakly aligned only*, red *misaligned (kind)*.
The ontology version is shown after the verdict.

Output message:

```js
msg.payload = {
  asset, ptView, phiVersion, candidate, warnings,
  level: 'strong' | 'weak' | 'none',
  aligned,                       // level === 'strong'
  reusedByRefinement, refinement,
  strong: { aligned, witness, stats }, weak: { ... },
  labelEquivalence: [{ pt, dt }], propositionEquivalence: [...],
  witness: { kind, message, trace: [{ pt, dt, move, clocks }], countermodels: [...] }
}
msg.cypher = [ ... ]             // wire to the same Neo4j writer as dt-graph
```

Witness kinds are `criticality`, `saturation`, `state`, `event`, `delay`, `internal` and
`limit` (state space exceeded `maxNodes`).

### 3.4 `dt-align-gate`

Put it between anything that derives *decisions* from the DT (an optimiser's setpoints, a
self-adaptation planner, an update proposal) and the PT:

* output 1 receives the message, with `msg.alignment`, while the DT is aligned at the required
  level;
* output 2 receives it otherwise, with `msg.blockedBecause` (level and witness message).

The gate updates its status live as verdicts change.

### 3.5 Knowledge graph

`dt-graph` now also writes events and the new annotations. `dt-alignment` adds the verdict.

```cypher
(:Property {binding})                     (:Action {interpretation})
(:Asset)-[:hasEvent]->(:Event {interpretation})
(:Asset)-[:ALIGNED_WITH {level, ontology_version, checked_at, reused}]->(:PTView {name})
(:Action|Event)-[:DOMAIN_EQUIVALENT]->(:PTLabel {name, view})
```

All string values are escaped for Cypher literals.

---

## 4. File formats

### 4.1 Timed automaton (JSON)

```json
{
  "name": "DroneDT",
  "clocks": ["t"],
  "initial": "Ready",
  "locations": [
    { "name": "Ready",    "labels": ["onGround"] },
    { "name": "Spraying", "invariant": "t <= 30", "labels": ["flying", "dispensing"] }
  ],
  "edges": [
    { "from": "Ready",    "to": "Spraying", "label": "sprayStarted", "reset": "t" },
    { "from": "Spraying", "to": "Spraying", "label": "cellCompleted", "guard": "t >= 10", "reset": "t" },
    { "from": "Spraying", "to": "Spraying", "label": "logTelemetry" }
  ]
}
```

Constraints are conjunctions (`&&`, `and` or `,`) of `x ~ c` or `x - y ~ c`, where `~` is one
of `< <= == >= >` and `c` is an integer. Lists may also be given as comma-separated strings.

### 4.2 Ontology

```text
sort Energy            ; user sorts range over Real ...
sort Count : Int       ; ... unless a base sort is given
fun soc : Energy
fun cons : Cell -> Energy
rel armed :
axiom reserve : (= soc_rtb 25)
```

`;` starts a comment, and a statement may span lines while parentheses are open. Axioms are
SMT-LIB2 Boolean terms; quantifier-free linear real/integer arithmetic is the intended
fragment.

### 4.3 Interpretation

```text
label : <SMT-LIB2 Boolean term>
label : tau
```

A label without an entry is internal. In a `dt-pt-view`, the proposition labels are the
`labels` of the JSON locations. For UPPAAL imports, each location carries its own name as its
proposition.

### 4.4 UPPAAL import

`dt-pt-view` (format *UPPAAL XML*) and the CLI (`*.xml`) read one template (the first one, or
the one you name). They import clocks, invariants, guards, synchronisations (used as labels,
e.g. `bat_low!`) and clock resets (`x = 0`). Guards over data variables and non-clock
assignments are rejected with an error. Urgent/committed markers are not supported and are
ignored, so model urgency with an invariant such as `x <= 0` instead.

---

## 5. Command line

`npm install` exposes `dt-align` (`src/alignment/cli.js`). It exits with 0 when aligned (or
when refinement holds), 1 otherwise and 2 on usage errors.

```bash
cd examples/drone

# strong alignment (default), with a critical event
dt-align --pt pt.json --dt dt.json --ontology drone.ont \
         --pt-interp pt.interp --dt-interp dt.interp --critical 'bat_low!'
# strong semantic alignment: ALIGNED
#   |E|=6 smt=49 product=4 relation=4 time=63ms

# weak mode, classical (syntactic) matching, JSON output, tau bound
dt-align ... --mode weak
dt-align --pt pt.json --dt dt.json --syntactic
dt-align ... --json --max-tau 3

# knowledge refinement: does the new ontology refine the old one?
dt-align --refines --ontology drone_v2_reserve.ont --pt-interp pt.interp --dt-interp dt.interp \
         --old-ontology drone.ont --old-pt-interp pt.interp --old-dt-interp dt.interp
# Phi' refines Phi: false
#  (b) reserve: axiom 'reserve' of the old ontology is not entailed by the new axioms {"soc_rtb":"30"}
```

Example witnesses:

```text
# DT threshold drift: lowBattery is (< soc 20)
witness (criticality): critical PT event 'bat_low!' has 0 domain-equivalent DT events; exactly
  one is required; closest DT candidate(s) lowBattery denote a different condition
  countermodel bat_low! vs lowBattery: {"soc":"20","soc_rtb":"25"}

# DT promises cells within 40 s (PT: 30 s); weakly aligned only
witness (delay): DT may still delay in 'Spraying' but the PT invariant of 'SPRAYING' (x<=30)
  forces it to leave: the delay is not matched (Condition IV)
   0. (LANDED, Ready) PT event arm? @ PT.x=0, DT.t=0
   1. (TAKEOFF, Ascending) PT event start_spray! @ PT.x=3, DT.t=3
   2. (SPRAYING, Spraying)  @ PT.x=35, DT.t=35
```

Programmatic use:

```js
const A = require('node-red-contrib-digital-twin-aligned/src/alignment');
const res = A.checkAlignment(ptView, dtView, { ontology, pt, dt }, { mode: 'strong', critical: ['bat_low!'] });
const ref = A.checkKnowledgeRefinement(phiNew, phiOld);
const lifted = A.liftAsset(flowJson, 'drone');   // { view, interpretation, warnings, ... }
```

---

## 6. Worked example: crop-spraying drone

`examples/drone/` contains:

| File | Contents |
|------|----------|
| `drone.ont` | shared ontology: state of charge, altitude, pump flow, cells, RTB reserve, altitude cap |
| `drone_v2_wind.ont`, `drone_v2_reserve.ont` | two evolutions: wind limits (a refinement), reserve raised to 30 % (not a refinement) |
| `pt.json`, `pt.interp` | flight-controller PT view and interpretation; `bat_low!` is critical |
| `dt.json`, `dt.interp` | the DT view and interpretation as lifted from the flow (for the CLI) |
| `build-flow.js` | generates `drone-flow.json`: a full Node-RED flow with `dt-graph`, the drone asset, its properties, actions and events, `dt-behavior`, `dt-alignment`, a what-if inject and an optimiser behind `dt-align-gate` |

`node bench/drone-variants.js` checks six DT variants and three ontology evolutions. For each
one it also tests whether the original tool's knowledge graph changes:

| Variant | Change | KG differs? | Strong | Weak |
|---------|--------|:-----------:|:------:|:----:|
| V0 | reference DT | — | ✓ | ✓ |
| V1 | `lowBattery` at 20 % instead of 25 % | no | ✗ | ✗ |
| V2 | DT claims cells finish within 20 s | no | ✗ | ✗ |
| V3 | DT allows cells up to 40 s | no | ✗ | ✓ |
| V4 | `lowBattery` left uninterpreted | no | ✗ | ✗ |
| V5 | extra DT-only action `pauseSpray` | yes | ✗ | ✓ |

Classical syntactic bisimulation rejects every variant, V0 included, because the twins use
different vocabularies. The original knowledge graph cannot tell V0–V4 apart. Each check takes
well under 100 ms.

`node bench/nodered-e2e.js <userDir>` replays the scenario in a real Node-RED runtime (tested
with Node-RED 4; this package must be installed in `<userDir>`). The steps are deploy, a refining ontology change
(verdict reused), a misaligned redeploy (optimiser command blocked) and a what-if check.

---

## 7. Limitations

* Views are clock-only timed automata. Data variables must be abstracted into locations or
  ontology-level propositions.
* Interpretations are evaluated statically: a label denotes a *condition*, not a value
  trajectory. Continuous dynamics are outside the model.
* Matching allows a bounded number (`maxTau`, default 2) of internal steps. A larger τ-depth
  may be needed for heavily internal DT models.
* The verdict is computed at design time (deploy). Runtime conformance monitoring of live
  telemetry against the DT is complementary and not part of this package.
