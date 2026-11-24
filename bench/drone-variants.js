#!/usr/bin/env node
/**
 * Drone case study.  For each DT variant we report
 *  - whether the knowledge graph produced by the ORIGINAL tool differs from V0's,
 *  - classical (syntactic) weak timed bisimulation,
 *  - strong / weak semantic alignment (this work) with witness and timing.
 * Ontology evolution: knowledge refinement before re-checking.
 * Writes bench/results/drone_variants.json.
 *
 * The knowledge-graph baseline is the Cypher generator of the original package,
 * taken from upstream commit 5d71fdf (via `git show`) unless ORIGINAL_CYPHER
 * points to a copy of the original src/resources/cypher.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('../src/alignment');
const { buildFlow } = require('../examples/drone/build-flow');
const os = require('os');
const { execFileSync } = require('child_process');

function loadOriginalCypher() {
    let file = process.env.ORIGINAL_CYPHER;
    if (!file) {
        const src = execFileSync('git', ['show', '5d71fdf:src/resources/cypher.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-orig-')), 'cypher.js');
        fs.writeFileSync(file, src);
    }
    return require(path.resolve(file)).Cypher;
}
const ORIGINAL_CYPHER = loadOriginalCypher();

const ex = (f) => path.join(__dirname, '..', 'examples', 'drone', f);
const read = (f) => fs.readFileSync(ex(f), 'utf8');
const out = path.join(__dirname, 'results');
fs.mkdirSync(out, { recursive: true });

const PT = A.parseTA(JSON.parse(read('pt.json')));
const PT_I = A.parseInterpretation(read('pt.interp'));
const ONT = { base: A.parseOntology(read('drone.ont')), wind: A.parseOntology(read('drone_v2_wind.ont')), reserve: A.parseOntology(read('drone_v2_reserve.ont')) };

/** Knowledge graph of the original tool (dt-graph deploy logic, original Cypher converter). */
function originalKnowledgeGraph(flow) {
    // the original tool knows neither behaviours nor interpretations/bindings
    const nodes = flow.filter(n => n.type && n.type.startsWith('dt-') && !['dt-behavior', 'dt-ontology', 'dt-pt-view', 'dt-alignment', 'dt-align-gate'].includes(n.type))
        .map(n => { const c = { ...n }; delete c.interpretation; delete c.binding; c.wires = (n.wires || [[]]).map(w => w.filter(id => id !== 'behavior')); return c; });
    const assets = [];
    const relations = new Map();
    for (const a of nodes.filter(n => n.type.startsWith('dt-asset'))) {
        const asset = { ...a };
        const outgoing = nodes.filter(n => a.wires[0].includes(n.id));
        const incoming = nodes.filter(n => n.wires[0] && n.wires[0].includes(a.id));
        for (const n of [...outgoing, ...incoming]) {
            if (n.type === 'dt-property') (asset.properties = asset.properties || []).push(n);
            else if (n.type === 'dt-action') (asset.actions = asset.actions || []).push(n);
            else if (n.type === 'dt-event') (asset.events = asset.events || []).push(n);
            else if (n.type === 'dt-relation') relations.set(n.id, { id: n.id, name: n.name, direction: n.direction, origins: nodes.filter(m => m.wires[0] && m.wires[0].includes(n.id)), targets: nodes.filter(m => n.wires[0].includes(m.id)) });
        }
        assets.push(asset);
    }
    const cypher = new ORIGINAL_CYPHER().convertAssetsRelations(assets, Array.from(relations.values()));
    return crypto.createHash('sha256').update(cypher.join('\n')).digest('hex').slice(0, 12);
}

const VARIANTS = [
    { id: 'V0', desc: 'reference DT', flow: {} },
    { id: 'V1', desc: 'threshold drift: lowBattery at 20 %', flow: { interpretations: { lowBattery: '(< battery 20)' } } },
    { id: 'V2', desc: 'optimistic timing: cell within 20 s', flow: { behavior: { cellBound: 20 } } },
    { id: 'V3', desc: 'conservative timing: cell within 40 s', flow: { behavior: { cellBound: 40 } } },
    { id: 'V4', desc: 'missing interpretation of lowBattery', flow: { interpretations: { lowBattery: '' } } },
    { id: 'V5', desc: 'DT-only action pauseSpray', flow: {
        extraActionIds: ['pauseSpray'], extraActions: [{ id: 'pauseSpray', name: 'pauseSpray' }],
        interpretations: { pauseSpray: '(and (> altitude 0) (= pumpFlow 0))' },
        behavior: { extraLocations: [{ name: 'Hovering', invariant: 't <= 10', labels: ['flying'] }],
                    extraEdges: [{ from: 'Spraying', to: 'Hovering', label: 'pauseSpray', reset: 't' }, { from: 'Hovering', to: 'Spraying', label: 'sprayStarted', reset: 't' }] } } },
];

function knowledge(flowOpts, ont) {
    const flow = buildFlow(flowOpts);
    const L = A.liftAsset(flow, 'drone');
    return { flow, lifted: L, phi: { ontology: ont, pt: PT_I, dt: L.interpretation } };
}

function run(phi, view, mode) {
    return A.checkAlignment(PT, view, phi, { mode, critical: ['bat_low!'] });
}

const summarize = (r) => r.witness ? `${r.witness.kind}: ${r.witness.message}` : '';
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const timed = (f, reps = 5) => { let r; const ts = []; for (let k = 0; k < reps; k++) { const t = process.hrtime.bigint(); r = f(); ts.push(Number(process.hrtime.bigint() - t) / 1e6); } return { r, ms: median(ts) }; };

const rows = [];
const kg0 = originalKnowledgeGraph(buildFlow({}));
for (const v of VARIANTS) {
    const { flow, lifted, phi } = knowledge(v.flow, ONT.base);
    const kg = originalKnowledgeGraph(flow);
    const syn = A.checkAlignment(PT, lifted.view, null, { matching: 'syntactic' });
    const s = timed(() => run(phi, lifted.view, 'strong'));
    const w = timed(() => run(phi, lifted.view, 'weak'));
    rows.push({
        id: v.id, desc: v.desc, kgHash: kg, kgSameAsV0: kg === kg0, syntactic: syn.aligned,
        strong: s.r.aligned, weak: w.r.aligned, strongMs: s.ms, weakMs: w.ms,
        smtCalls: s.r.stats.smtCalls, productNodes: s.r.stats.productNodes, relation: s.r.stats.relationSize,
        witnessKind: s.r.witness ? s.r.witness.kind : null, witness: summarize(s.r), trace: s.r.witness ? s.r.witness.trace : [],
        countermodels: s.r.witness ? s.r.witness.countermodels : [], warnings: lifted.warnings,
    });
}

// ----------------------------------------------------------- ontology evolution
const evo = [];
{
    const base = knowledge({}, ONT.base);
    const before = run(base.phi, base.lifted.view, 'strong');
    // E1: wind knowledge added (conservative)
    const e1 = knowledge({}, ONT.wind);
    const ref1 = timed(() => A.checkKnowledgeRefinement(e1.phi, base.phi));
    const re1 = timed(() => run(e1.phi, e1.lifted.view, 'strong'));
    evo.push({ id: 'E1', desc: 'wind limits added', refines: ref1.r.holds, refineMs: ref1.ms, refineSmt: ref1.r.smtCalls, recheck: re1.r.aligned, recheckMs: re1.ms, verdict: before.aligned && ref1.r.holds ? 'aligned (reused by refinement)' : (re1.r.aligned ? 'aligned' : 'misaligned'), violations: ref1.r.violations });
    // E2: reserve raised to 30 %, DT keeps the literal 25
    const e2 = knowledge({}, ONT.reserve);
    const ref2 = timed(() => A.checkKnowledgeRefinement(e2.phi, base.phi));
    const re2 = timed(() => run(e2.phi, e2.lifted.view, 'strong'));
    evo.push({ id: 'E2', desc: 'reserve raised to 30 %', refines: ref2.r.holds, refineMs: ref2.ms, refineSmt: ref2.r.smtCalls, recheck: re2.r.aligned, recheckMs: re2.ms, verdict: re2.r.aligned ? 'aligned' : 'misaligned', witness: summarize(re2.r), countermodels: re2.r.witness ? re2.r.witness.countermodels : [], violations: ref2.r.violations });
    // E2': the DT refers to the reserve symbolically
    const sym = { interpretations: { lowBattery: '(< battery soc_rtb)' } };
    const e3old = knowledge(sym, ONT.base), e3 = knowledge(sym, ONT.reserve);
    const ref3 = timed(() => A.checkKnowledgeRefinement(e3.phi, e3old.phi));
    const re3 = timed(() => run(e3.phi, e3.lifted.view, 'strong'));
    evo.push({ id: "E2'", desc: 'E2 with symbolic reserve in the DT', refines: ref3.r.holds, refineMs: ref3.ms, refineSmt: ref3.r.smtCalls, recheck: re3.r.aligned, recheckMs: re3.ms, verdict: re3.r.aligned ? 'aligned' : 'misaligned', violations: ref3.r.violations });
}

fs.writeFileSync(path.join(out, 'drone_variants.json'), JSON.stringify({ rows, evo }, null, 2));
for (const r of rows) console.log(`${r.id} ${r.desc.padEnd(40)} KG=V0:${r.kgSameAsV0 ? 'yes' : 'no '} syn:${r.syntactic ? 'Y' : 'N'} strong:${r.strong ? 'Y' : 'N'} weak:${r.weak ? 'Y' : 'N'} ${r.strongMs.toFixed(0)}ms smt=${r.smtCalls} |prod|=${r.productNodes}\n    ${r.witness}\n    ${r.countermodels.map(c => `${c.pt}/${c.dt}: ${JSON.stringify(c.model)}`).join('; ')}`);
for (const e of evo) console.log(`${e.id} ${e.desc.padEnd(36)} refines:${e.refines} (${e.refineMs.toFixed(0)}ms, ${e.refineSmt} smt) recheck:${e.recheck} (${e.recheckMs.toFixed(0)}ms) => ${e.verdict}\n    ${(e.violations || []).map(v => `(${v.condition}) ${v.item} ${JSON.stringify(v.countermodel || {})}`).join('; ')} ${e.witness || ''}`);
