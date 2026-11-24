[![Platform Node-RED](http://b.repl.ca/v1/Platform-Node--RED-red.png)](https://flows.nodered.org/node/@digitaltwins/node-red-contrib-digital-twin)

# NodeRED nodes for modeling Digital Twins

A set of NodeRED nodes for modeling Digital Twins with semantics.

More information can be found here: [A methodology for creating semantic digital twin models supported by knowledge graphs](https://ieeexplore.ieee.org/document/9921499)


# Simple example
<img width="600" alt="nodes (1)" src="https://user-images.githubusercontent.com/3587083/188316228-9d59f0d5-caf5-4d2f-ac2a-54978500c380.png"> 



# Nodes
<img width="568" alt="nodes (1)" src="https://user-images.githubusercontent.com/3587083/186910297-93557df9-84fe-4acc-8540-dfb9214688f8.png">

- **dt-asset:** represents an observable asset from the real world. It can be composed by other assets.
- **dt-event:** events can happen internally or externally and can be used to trigger actions or change properties.
- **dt-action:** an asset can have actuation methods such as ``open()``, ``close()``...
- **dt-property:** used to define a property of an asset (``temperature``, ``humidity``...)
- **dt-relation:** it can be used to (semantically) represent the relation between two nodes.
- **dt-graph:** it watches the model and creates/updates a knowledge graph everytime the diagram is deployed.
##


## Citing
``` bibtex
@INPROCEEDINGS{steinmetz2022,  
author={Steinmetz, Charles and Schroeder, Greyce N. and Sulak, Adam and Tuna, Kaan and Binotto, Alecio and Rettberg, Achim and Pereira, Carlos Eduardo},  booktitle={2022 IEEE 27th International Conference on Emerging Technologies and Factory Automation (ETFA)},   
title={A methodology for creating semantic digital twin models supported by knowledge graphs},   
year={2022},
pages={1-7},  
doi={10.1109/ETFA52439.2022.9921499}
}
```

---

# Semantic alignment extension (this fork)

The original nodes give a DT a shared **vocabulary**. This fork adds formally checked
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

### Requirements
Node.js ≥ 16 and the `z3` binary on the `PATH` (or `Z3_PATH`, or the node's *z3 binary* field).

### Install
```bash
cd ~/.node-red
npm install <path-to-this-repo>      # or: npm install github:lucabrodohshl/node-red-contrib-digital-twin#semantic-alignment
```
Install it *instead of* `@digitaltwins/node-red-contrib-digital-twin`, not next to it: both
packages register the same node types.

### Quick start
```bash
npm install && npm run build && npm test          # unit tests
node examples/drone/build-flow.js                 # writes examples/drone/drone-flow.json
node-red examples/drone/drone-flow.json           # (package installed in your Node-RED user dir)
```

### Command line
```bash
cd examples/drone
npx dt-align --pt pt.json --dt dt.json --ontology drone.ont \
             --pt-interp pt.interp --dt-interp dt.interp --critical 'bat_low!'
# strong semantic alignment: ALIGNED
npx dt-align --refines --ontology drone_v2_reserve.ont --pt-interp pt.interp --dt-interp dt.interp \
             --old-ontology drone.ont --old-pt-interp pt.interp --old-dt-interp dt.interp
```

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
