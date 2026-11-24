# Semantically aligned Digital Twins for Node-RED

Node-RED nodes for modelling Digital Twins whose **behaviour is checked against the Physical
Twin**, not only their vocabulary.

This package extends [node-red-contrib-digital-twin](https://github.com/steinmetz/node-red-contrib-digital-twin)
by Charles Steinmetz et al. ([ETFA 2022](https://ieeexplore.ieee.org/document/9921499)). That
package models a DT as assets, properties, actions, events and relations with semantic
annotations, and stores them in a knowledge graph. Everything it provides still works
unchanged; this package adds the alignment layer on top.

## What it adds

The original nodes give a DT a shared **vocabulary**. This package adds formally checked
**semantic alignment** between the DT model and its Physical Twin (PT): *is every behaviour of
the DT realisable by the PT (and vice versa) once both are read through a shared ontology?*

Alignment is a weak timed bisimulation modulo domain equivalence. Both twins are timed
automata. Their events and state propositions are interpreted as formulas over a shared
ontology, and two labels match when the ontology's axioms make them equivalent. The check
runs with zones and the z3 SMT solver every time you deploy. A failure comes with a witness:
a timed trace plus an SMT countermodel.

**Full documentation: [docs/semantic-alignment.md](docs/semantic-alignment.md)**

| Node | What it adds |
|------|--------------|
| `dt-property` | optional **ontology term** (binding), e.g. `battery` ↦ `soc` |
| `dt-action`, `dt-event` | optional **interpretation**: an SMT-LIB formula over the ontology; empty = internal (τ) |
| `dt-behavior` *(new)* | the asset's **timed behaviour** (timed automaton, JSON) + state propositions; wire the asset to it |
| `dt-ontology` *(config, new)* | shared ontology `K = (S, F, R, Δ)` with a version |
| `dt-pt-view` *(config, new)* | PT view (JSON or UPPAAL XML, clocks only) + PT interpretation + critical events |
| `dt-alignment` *(new)* | checks strong/weak alignment on deploy; witness on failure; Cypher for `ALIGNED_WITH` / `DOMAIN_EQUIVALENT`; reuses the verdict when the new ontology refines the old one; *what-if* check of a candidate behaviour sent as `msg.payload.behavior` |
| `dt-align-gate` *(new)* | forwards DT-derived decisions (optimizer setpoints, adaptation commands) only while the DT is aligned at the required level |

Flows built with the original package load unchanged. `dt-graph` now also writes events,
bindings and interpretations to the knowledge graph.

| Verdict | Meaning | Licenses |
|---------|---------|----------|
| **strong** | DT ⇄ PT, modulo domain equivalence | prediction, optimisation, what-if |
| **weak** | every PT behaviour has a DT counterpart | monitoring |
| **none** | witness reported | — |

### Why vocabulary is not enough

In the drone example (`examples/drone`), the DT's `lowBattery` and the flight controller's
`bat_low!` carry the same semantic type. Each variant below changes the DT's behaviour. The
original tool's knowledge graph is identical for V0–V4, so it cannot see these changes; the
alignment check catches every one:

| Variant | Change to the DT | Original KG changes? | Verdict |
|---------|------------------|:--------------------:|---------|
| V0 | reference model | — | **strong** |
| V1 | `lowBattery` fires at 20 % (PT: below the 25 % reserve) | no | none: countermodel `soc = 20` |
| V2 | claims a field cell is sprayed within 20 s (PT: 10–30 s) | no | none: delay not matched |
| V3 | allows up to 40 s per cell | no | **weak**: monitoring only |
| V4 | `lowBattery` left uninterpreted | no | none: critical `bat_low!` has no counterpart |
| V5 | extra DT-only action `pauseSpray` | yes | **weak** |

If the ontology changes (e.g. wind limits are added), the verdict is reused without
re-checking when the new ontology refines the old one. If the change breaks a meaning (e.g. the
reserve is raised to 30 %), the full check runs again and reports what no longer matches.

### Requirements
Node.js ≥ 16 and the `z3` binary on the `PATH` (or `Z3_PATH`, or the node's *z3 binary* field).

### Install
```bash
cd ~/.node-red
npm install github:lucabrodohshl/node-red-contrib-digital-twin#semantic-alignment
# or, from a local clone:  npm install /path/to/node-red-contrib-digital-twin
```
Install it *instead of* `@digitaltwins/node-red-contrib-digital-twin`, not next to it: both
packages register the same node types.

### Quick start (from a clone)
```bash
npm install && npm run build && npm test          # build and run the unit tests
node examples/drone/build-flow.js                 # writes examples/drone/drone-flow.json
```
Then import `examples/drone/drone-flow.json` into Node-RED (with this package installed) and
deploy. The `dt-alignment` node turns green (*strongly aligned*). The *what-if* inject checks a
40 s variant without deploying it, and the optimiser's command passes `dt-align-gate`.

### Command line
The checker also runs without Node-RED (`dt-align` once the package is installed):
```bash
cd examples/drone
node ../../src/alignment/cli.js --pt pt.json --dt dt.json --ontology drone.ont \
     --pt-interp pt.interp --dt-interp dt.interp --critical 'bat_low!'
# strong semantic alignment: ALIGNED

node ../../src/alignment/cli.js --refines --ontology drone_v2_reserve.ont \
     --pt-interp pt.interp --dt-interp dt.interp \
     --old-ontology drone.ont --old-pt-interp pt.interp --old-dt-interp dt.interp
# Phi' refines Phi: false
#  (b) reserve: axiom 'reserve' of the old ontology is not entailed by the new axioms {"soc_rtb":"30"}
```
Options: `--mode weak`, `--syntactic` (classical bisimulation), `--max-tau N`, `--json`.
PT/DT views can be JSON or UPPAAL XML (`*.xml`).

### Drone case study
```bash
node bench/drone-variants.js        # 6 DT variants + 3 ontology evolutions -> bench/results/
node bench/nodered-e2e.js <userDir> # live Node-RED redeploy scenario (package installed in <userDir>)
```

### Engine layout (`src/alignment/`)
`dbm.ts` (zones: DBMs, subtraction, extrapolation), `ta.ts` (timed automata, UPPAAL import,
composition), `smt.ts` (batched z3), `ontology.ts` (ontologies, interpretations),
`checker.ts` (alignment: product zone graph with joint clocks, coverage-based matching,
greatest fixpoint, witnesses, active-clock reduction), `refinement.ts` (knowledge refinement),
`lifting.ts` (Node-RED flow → DT view + interpretation), `native.ts` (optional external
checker back-end), `cli.ts`.

---

## Base package: semantic DT modelling

The nodes inherited from the original package. They behave as before; the extension only adds
optional fields to `dt-property`, `dt-action` and `dt-event`, and `dt-graph` additionally
records events, bindings and interpretations.

### Simple example
<img width="600" alt="simple example" src="https://user-images.githubusercontent.com/3587083/188316228-9d59f0d5-caf5-4d2f-ac2a-54978500c380.png">

### Nodes
<img width="568" alt="nodes (1)" src="https://user-images.githubusercontent.com/3587083/186910297-93557df9-84fe-4acc-8540-dfb9214688f8.png">

- **dt-asset:** represents an observable asset from the real world. It can be composed by other assets.
- **dt-event:** events can happen internally or externally and can be used to trigger actions or change properties.
- **dt-action:** an asset can have actuation methods such as ``open()``, ``close()``...
- **dt-property:** used to define a property of an asset (``temperature``, ``humidity``...)
- **dt-relation:** it can be used to (semantically) represent the relation between two nodes.
- **dt-model:** placeholder for a sub-model of an asset (not written to the knowledge graph).
- **dt-graph:** it watches the model and creates/updates a knowledge graph everytime the diagram is deployed.

## Citing the base package
``` bibtex
@INPROCEEDINGS{steinmetz2022,  
author={Steinmetz, Charles and Schroeder, Greyce N. and Sulak, Adam and Tuna, Kaan and Binotto, Alecio and Rettberg, Achim and Pereira, Carlos Eduardo},  booktitle={2022 IEEE 27th International Conference on Emerging Technologies and Factory Automation (ETFA)},   
title={A methodology for creating semantic digital twin models supported by knowledge graphs},   
year={2022},
pages={1-7},  
doi={10.1109/ETFA52439.2022.9921499}
}
```

## License

MIT, as the original package (see [LICENSE](LICENSE)).
