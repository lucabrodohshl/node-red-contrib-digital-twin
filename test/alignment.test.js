const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../src/alignment');
const { buildFlow } = require('../examples/drone/build-flow');

const ex = (f) => fs.readFileSync(path.join(__dirname, '..', 'examples', 'drone', f), 'utf8');

// ------------------------------------------------------------------ DBMs
test('DBM: delay, constrain, reset, inclusion', () => {
    const z = A.DBM.zero(3).up();                 // x = y >= 0
    const g = z.and([{ i: 1, j: 0, bound: A.le(5) }]);
    assert.ok(g && g.includes(A.DBM.zero(3)));
    assert.ok(!g.satisfies({ i: 2, j: 0, bound: A.le(4) }));
    assert.ok(g.satisfies({ i: 2, j: 0, bound: A.le(5) })); // y = x <= 5
    const r = g.reset(1);                          // x = 0, y in [0,5]
    assert.ok(r.satisfies({ i: 1, j: 0, bound: A.le(0) }));
    assert.equal(z.and([{ i: 1, j: 0, bound: A.lt(0) }]), null);
});

test('DBM: subtraction and coverage are exact', () => {
    const z = A.DBM.universe(2).and([{ i: 1, j: 0, bound: A.le(10) }]); // 0<=x<=10
    const a = A.DBM.universe(2).and([{ i: 1, j: 0, bound: A.lt(4) }]);  // x<4
    const b = A.DBM.universe(2).and([{ i: 0, j: 1, bound: A.le(-4) }]); // x>=4
    assert.equal(A.uncoveredPart(z, [a, b]), null);
    const b2 = A.DBM.universe(2).and([{ i: 0, j: 1, bound: A.lt(-4) }]); // x>4
    const gap = A.uncoveredPart(z, [a, b2]);
    assert.ok(gap);
    assert.deepEqual(gap.sample(), [4]);
});

test('clock constraint parser', () => {
    assert.deepEqual(A.parseConstraints('x <= 5 && 3 < y'), [{ x: 'x', op: '<=', c: 5 }, { x: 'y', op: '>', c: 3 }]);
    assert.deepEqual(A.parseConstraints('true'), []);
    assert.throws(() => A.parseConstraints('x <= y'));
});

// --------------------------------------------------------------- ontology
test('ontology and interpretation parsing, substitution', () => {
    const o = A.parseOntology('sort E\nsort C : Int\nfun soc : E\nfun f : C -> E\nrel ok :\naxiom a1 : (and (>= soc 0)\n   (<= soc 100))');
    assert.equal(o.functions.find(f => f.name === 'f').args[0], 'Int');
    assert.equal(o.functions.find(f => f.name === 'ok').ret, 'Bool');
    assert.equal(o.axioms[0].formula, '(and (>= soc 0) (<= soc 100))');
    const I = A.parseInterpretation('bat_low! : (< soc 25)\nlog : tau');
    assert.equal(I.get('bat_low!'), '(< soc 25)');
    assert.ok(A.isTau(I.get('log')));
    assert.equal(A.substitute('(< battery 25)', new Map([['battery', 'soc']])), '(< soc 25)');
});

// ------------------------------------------------------------- alignment
const ONT = A.parseOntology('fun v : Real\naxiom nn : (>= v 0)');
const ta = (name, inv, guard, label, extra = {}) => A.parseTA({
    name, clocks: ['c'], initial: 'A',
    locations: [{ name: 'A', invariant: inv, labels: extra.labA || [] }, { name: 'B', labels: extra.labB || [] }],
    edges: [{ from: 'A', to: 'B', label, guard }, ...(extra.edges || [])],
});
const phi = (pt, dt) => ({ ontology: ONT, pt: new Map(Object.entries(pt)), dt: new Map(Object.entries(dt)) });

test('semantic matching: different labels, equivalent meaning', () => {
    const r = A.checkAlignment(ta('P', 'c <= 5', 'c >= 2', 'hi!'), ta('D', 'c <= 5', 'c >= 2', 'high'),
        phi({ 'hi!': '(> v 10)' }, { high: '(not (<= v 10))' }));
    assert.equal(r.aligned, true);
    assert.deepEqual(r.labelEquivalence, [{ pt: 'hi!', dt: 'high' }]);
    const s = A.checkAlignment(ta('P', 'c <= 5', 'c >= 2', 'hi!'), ta('D', 'c <= 5', 'c >= 2', 'high'), null, { matching: 'syntactic' });
    assert.equal(s.aligned, false);
});

test('meaning mismatch yields a countermodel', () => {
    const r = A.checkAlignment(ta('P', '', '', 'hi!'), ta('D', '', '', 'high'), phi({ 'hi!': '(> v 10)' }, { high: '(> v 12)' }));
    assert.equal(r.aligned, false);
    assert.equal(r.witness.kind, 'event');
    const m = r.witness.countermodels[0].model;
    assert.ok(Number(m.v) > 10 && Number(m.v) <= 12);
});

test('guards: DT enabling window must cover the PT window', () => {
    const P = ta('P', 'c <= 5', 'c >= 2', 'e'), I = phi({ e: '(> v 1)' }, { e: '(> v 1)' });
    assert.equal(A.checkAlignment(P, ta('D', 'c <= 5', 'c >= 3', 'e'), I).aligned, false);
    assert.equal(A.checkAlignment(P, ta('D', 'c <= 5', 'c >= 1', 'e'), I, { mode: 'weak' }).aligned, true);
    assert.equal(A.checkAlignment(P, ta('D', 'c <= 5', 'c >= 1', 'e'), I, { mode: 'strong' }).aligned, false);
});

test('delays: invariants are matched (Condition IV)', () => {
    const I = phi({ e: '(> v 1)' }, { e: '(> v 1)' });
    const P = ta('P', 'c <= 5', '', 'e');
    const tight = A.checkAlignment(P, ta('D', 'c <= 3', '', 'e'), I, { mode: 'weak' });
    assert.equal(tight.aligned, false);
    assert.equal(tight.witness.kind, 'delay');
    const loose = ta('D', 'c <= 8', '', 'e');
    assert.equal(A.checkAlignment(P, loose, I, { mode: 'weak' }).aligned, true);
    assert.equal(A.checkAlignment(P, loose, I, { mode: 'strong' }).aligned, false);
});

test('internal steps of the DT are abstracted (weak timed bisimulation)', () => {
    const P = ta('P', 'c <= 5', '', 'e');
    const D = A.parseTA({ name: 'D', clocks: ['c'], initial: 'A', locations: [{ name: 'A', invariant: 'c <= 5', labels: [] }, { name: 'L', invariant: 'c <= 5', labels: [] }, { name: 'B', labels: [] }],
        edges: [{ from: 'A', to: 'L', label: 'log' }, { from: 'L', to: 'B', label: 'e' }, { from: 'A', to: 'B', label: 'e' }] });
    assert.equal(A.checkAlignment(P, D, phi({ e: '(> v 1)' }, { e: '(> v 1)' })).aligned, true);
});

test('state consistency and saturation (Condition I)', () => {
    const I = phi({ e: '(> v 1)', p: '(> v 5)' }, { e: '(> v 1)', q: '(> v 5)', r: '(> v 6)' });
    assert.equal(A.checkAlignment(ta('P', '', '', 'e', { labB: ['p'] }), ta('D', '', '', 'e', { labB: ['q'] }), I).aligned, true);
    const bad = A.checkAlignment(ta('P', '', '', 'e', { labB: ['p'] }), ta('D', '', '', 'e', { labB: ['r'] }), I);
    assert.equal(bad.witness.kind, 'state');
    const I2 = phi({ e: '(> v 1)', p: '(> v 5)' }, { e: '(> v 1)', q: '(> v 5)', q2: '(< 5 v)' });
    assert.equal(A.checkAlignment(ta('P', '', '', 'e', { labB: ['p'] }), ta('D', '', '', 'e', { labA: ['q2'], labB: ['q'] }), I2).witness.kind, 'saturation');
});

test('bisimulation-criticality', () => {
    const D = ta('D', '', '', 'e1', { edges: [{ from: 'A', to: 'B', label: 'e2' }] });
    const I = phi({ e: '(> v 1)' }, { e1: '(> v 1)', e2: '(< 1 v)' });
    assert.equal(A.checkAlignment(ta('P', '', '', 'e'), D, I).aligned, true);
    assert.equal(A.checkAlignment(ta('P', '', '', 'e'), D, I, { critical: ['e'] }).witness.kind, 'criticality');
});

// ------------------------------------------------------------- refinement
test('knowledge refinement (a)-(c)', () => {
    const base = { ontology: A.parseOntology(ex('drone.ont')), pt: A.parseInterpretation(ex('pt.interp')), dt: new Map() };
    const wind = { ...base, ontology: A.parseOntology(ex('drone_v2_wind.ont')) };
    const reserve = { ...base, ontology: A.parseOntology(ex('drone_v2_reserve.ont')) };
    assert.equal(A.checkKnowledgeRefinement(wind, base).holds, true);
    const r = A.checkKnowledgeRefinement(reserve, base);
    assert.equal(r.holds, false);
    assert.equal(r.violations[0].condition, 'b');
    assert.equal(A.checkKnowledgeRefinement(base, wind).violations[0].condition, 'a');
});

// ------------------------------------------------- drone case study (flow)
test('drone DT modelled in Node-RED is strongly aligned with the PT view', () => {
    const L = A.liftAsset(buildFlow({}), 'drone');
    const p = { ontology: A.parseOntology(ex('drone.ont')), pt: A.parseInterpretation(ex('pt.interp')), dt: L.interpretation };
    const PT = A.parseTA(JSON.parse(ex('pt.json')));
    assert.equal(A.checkAlignment(PT, L.view, p, { critical: ['bat_low!'] }).aligned, true);
    const drift = A.liftAsset(buildFlow({ interpretations: { lowBattery: '(< battery 20)' } }), 'drone');
    const r = A.checkAlignment(PT, drift.view, { ...p, dt: drift.interpretation }, { critical: ['bat_low!'] });
    assert.equal(r.aligned, false);
    assert.deepEqual(r.witness.countermodels[0].model, { soc: '20', soc_rtb: '25' });
});

test('UPPAAL round trip preserves the verdict', () => {
    const PT = A.parseTA(JSON.parse(ex('pt.json')));
    const back = A.parseUppaalXml(A.toUppaalXml(PT, null));
    assert.equal(back.locations.length, PT.locations.length);
    assert.equal(back.edges.length, PT.edges.length);
    assert.equal(A.checkAlignment(PT, back, null, { matching: 'syntactic' }).aligned, false); // labels gain '!' / are sanitised
});

test('original dt-graph Cypher still works and now records interpretations and events', () => {
    const { Cypher } = require('../src/resources/cypher');
    const flow = buildFlow({});
    const asset = { ...flow.find(n => n.id === 'drone') };
    asset.properties = flow.filter(n => n.type === 'dt-property');
    asset.actions = flow.filter(n => n.type === 'dt-action');
    asset.events = flow.filter(n => n.type === 'dt-event');
    const c = new Cypher().convertAssetsRelations([asset], []).join('\n');
    assert.match(c, /:Event \{nodered_id: 'lowBattery'\}/);
    assert.match(c, /interpretation = '\(< battery 25\)'/);
    assert.match(c, /binding = 'soc'/);
});
