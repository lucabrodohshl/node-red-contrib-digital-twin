"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAlignment = void 0;
/**
 * Semantic alignment check between a PT view and a DT view.
 * See docs/semantic-alignment.md for the definitions (Conditions I-IV).
 *
 * Strong alignment is a weak timed bisimulation modulo domain equivalence:
 * matched states agree on the domain meaning of their propositions (Cond. I),
 * every interpreted event of one twin is matched by a domain-equivalent event
 * of the other (Cond. II/III) and delays are matched (Cond. IV).  Weak
 * alignment keeps only the PT-to-DT direction (Cond. I, II, PT-to-DT IV).
 *
 * The check runs on a product zone graph over the union of PT and DT clocks,
 * so delays elapse jointly and the delay clause is decided on zones.  The
 * matching side may take up to `maxTau` instantaneous internal steps before
 * (or instead of) a matching move.  Matching is decided per zone with exact
 * federation coverage; the computed relation is therefore a sound
 * under-approximation of the greatest alignment relation (an "aligned"
 * verdict is a proof, a "misaligned" verdict comes with a witness).
 */
const dbm_1 = require("./dbm");
const ta_1 = require("./ta");
const ontology_1 = require("./ontology");
const smt_1 = require("./smt");
/** Keeps the model entries for symbols that occur in the compared formulas. */
function relevantModel(model, formulas) {
    if (!model)
        return {};
    const syms = new Set([].concat(...formulas.map(f => (0, smt_1.tokenize)(f))));
    const r = {};
    Object.keys(model).filter(k => syms.has(k)).sort().forEach(k => (r[k] = model[k]));
    return Object.keys(r).length ? r : model;
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, ''));
function checkAlignment(pt, dt, phi, opts = {}) {
    var _a, _b;
    const t0 = Date.now();
    const mode = opts.mode || 'strong';
    const matching = opts.matching || 'semantic';
    const maxTau = (_a = opts.maxTau) !== null && _a !== void 0 ? _a : 2;
    const maxNodes = (_b = opts.maxNodes) !== null && _b !== void 0 ? _b : 500000;
    const stateMode = opts.stateMode || 'propositions';
    if (matching === 'semantic' && !phi)
        throw new Error('semantic matching requires domain knowledge');
    const tas = [pt, dt];
    const stats = { smtCalls: 0, labelPairsInE: 0, apClasses: 0, productNodes: 0, relationSize: 0, fixpointEvaluations: 0, timeMs: 0, smtTimeMs: 0 };
    // ------------------------------------------------ labels & interpretation
    const interp = (s) => (s === 0 ? phi === null || phi === void 0 ? void 0 : phi.pt : phi === null || phi === void 0 ? void 0 : phi.dt);
    const eventsOf = (ta) => Array.from(new Set(ta.edges.map(e => e.label).filter(l => !(0, ta_1.isInternalLabel)(l))));
    const apsOf = (ta) => Array.from(new Set([].concat(...ta.locations.map(l => l.labels))));
    const isObs = (s, label) => !(0, ta_1.isInternalLabel)(label) && (matching === 'syntactic' || !(0, ontology_1.isTau)(interp(s).get(label)));
    const events = [eventsOf(pt).filter(l => isObs(0, l)), eventsOf(dt).filter(l => isObs(1, l))];
    const internal = { pt: eventsOf(pt).filter(l => !isObs(0, l)), dt: eventsOf(dt).filter(l => !isObs(1, l)) };
    let aps = [[], []];
    const E = new Map(); // PT event -> DT events
    const Einv = new Map(); // DT event -> PT events
    events[0].forEach(a => E.set(a, new Set()));
    events[1].forEach(a => Einv.set(a, new Set()));
    const apClass = new Map(); // 'P:ap' / 'D:ap' -> class id
    const stateEq = new Set(); // location pairs with equivalent lifted interpretations
    const lifted = (s, labels) => {
        const fs_ = labels.map(a => interp(s).get(a)).filter(f => !(0, ontology_1.isTau)(f));
        return fs_.length === 0 ? 'true' : fs_.length === 1 ? fs_[0] : `(and ${fs_.join(' ')})`;
    };
    const preamble = phi ? (0, ontology_1.smtPreamble)(phi.ontology) : '';
    const base = phi ? phi.ontology.axioms.map(a => a.formula) : [];
    const smt = (qs) => {
        const ts = Date.now();
        const r = (0, smt_1.runSmtBatch)(preamble, base, qs, opts.z3Path);
        stats.smtCalls += qs.length;
        stats.smtTimeMs += Date.now() - ts;
        return r;
    };
    if (matching === 'syntactic') {
        for (const a of events[0])
            if (events[1].includes(a)) {
                E.get(a).add(a);
                Einv.get(a).add(a);
            }
    }
    else {
        const Ip = phi.pt, Id = phi.dt;
        const apCand = stateMode === 'formula' ? [[], []] : [apsOf(pt).filter(a => !(0, ontology_1.isTau)(Ip.get(a))), apsOf(dt).filter(a => !(0, ontology_1.isTau)(Id.get(a)))];
        // drop propositions that are valid under Delta: they carry no domain information
        const tq = [];
        apCand.forEach((l, s) => l.forEach(a => tq.push({ id: `${s}:${a}`, assertions: [`(not ${interp(s).get(a)})`] })));
        const tr = smt(tq);
        aps = [apCand[0].filter(a => tr.get(`0:${a}`).status !== 'unsat'), apCand[1].filter(a => tr.get(`1:${a}`).status !== 'unsat')];
        const queries = [];
        const pairs = [];
        const cache = new Map();
        const equivQuery = (f, g) => {
            if (f === g)
                return null; // syntactically identical: trivially equivalent
            const k = f < g ? `${f}\u0000${g}` : `${g}\u0000${f}`;
            if (!cache.has(k)) {
                const id = `q${cache.size}`;
                cache.set(k, id);
                queries.push({ id, assertions: [`(not (= ${f} ${g}))`] });
            }
            return cache.get(k);
        };
        const deferred = [];
        for (const a of events[0])
            for (const b of events[1])
                deferred.push({ id: equivQuery(Ip.get(a), Id.get(b)), then: () => { E.get(a).add(b); Einv.get(b).add(a); } });
        // union-find over all propositions of both twins
        const nodes = [...aps[0].map(a => `P:${a}`), ...aps[1].map(a => `D:${a}`)];
        const parent = new Map(nodes.map(n => [n, n]));
        const find = (x) => { while (parent.get(x) !== x)
            x = parent.get(x); return x; };
        const union = (x, y) => parent.set(find(x), find(y));
        const fOf = (n) => (n[0] === 'P' ? Ip : Id).get(n.slice(2));
        for (let i = 0; i < nodes.length; i++)
            for (let j = i + 1; j < nodes.length; j++) {
                const x = nodes[i], y = nodes[j];
                deferred.push({ id: equivQuery(fOf(x), fOf(y)), then: () => union(x, y) });
            }
        if (stateMode === 'formula') {
            for (const lp of pt.locations)
                for (const ld of dt.locations) {
                    const fp = lifted(0, lp.labels), fd = lifted(1, ld.labels);
                    const key = `${lp.name}\u0000${ld.name}`;
                    deferred.push({ id: equivQuery(fp, fd), then: () => stateEq.add(key) });
                }
        }
        const res = smt(queries);
        for (const d of deferred)
            if (d.id === null || res.get(d.id).status === 'unsat')
                d.then();
        void pairs;
        const roots = new Map();
        for (const n of nodes) {
            const r = find(n);
            if (!roots.has(r))
                roots.set(r, roots.size);
            apClass.set(n, roots.get(r));
        }
        stats.apClasses = roots.size;
    }
    E.forEach(s => (stats.labelPairsInE += s.size));
    const labelEquivalence = [];
    E.forEach((s, a) => s.forEach(b => labelEquivalence.push({ pt: a, dt: b })));
    const propositionEquivalence = [];
    for (const a of aps[0])
        for (const b of aps[1])
            if (apClass.get(`P:${a}`) === apClass.get(`D:${b}`))
                propositionEquivalence.push({ pt: a, dt: b });
    const finish = (aligned, witness) => {
        stats.timeMs = Date.now() - t0;
        return { aligned, mode, matching, witness, labelEquivalence, propositionEquivalence, internal, stats };
    };
    // --------------------------------------------- bisimulation-criticality
    for (const a of opts.critical || []) {
        const m = E.get(a);
        const n = m ? m.size : 0;
        if (n !== 1) {
            const w = {
                kind: 'criticality', trace: [], countermodels: [],
                message: `critical PT event '${a}' has ${n} domain-equivalent DT events${n ? ` (${Array.from(m).join(', ')})` : ''}; exactly one is required`,
            };
            if (n === 0 && matching === 'semantic' && phi.pt.get(a)) {
                const fa = phi.pt.get(a);
                const symsA = new Set((0, smt_1.tokenize)(fa).filter(t => phi.ontology.functions.some(f => f.name === t)));
                const cands = eventsOf(dt).filter(b => isObs(1, b) && (0, smt_1.tokenize)(phi.dt.get(b)).some(t => symsA.has(t)));
                const ans = smt(cands.map(b => ({ id: b, assertions: [`(not (= ${fa} ${phi.dt.get(b)}))`], wantModel: true })));
                ans.forEach((r, b) => { if (r.status === 'sat')
                    w.countermodels.push({ pt: a, dt: b, ptMeaning: fa, dtMeaning: phi.dt.get(b), model: relevantModel(r.model, [fa, phi.dt.get(b)]) }); });
                if (w.countermodels.length)
                    w.message += `; closest DT candidate(s) ${w.countermodels.map(c => c.dt).join(', ')} denote a different condition (see countermodel)`;
                else if (internal.dt.length)
                    w.message += `; DT label(s) without interpretation (treated as internal τ): ${internal.dt.join(', ')}`;
            }
            return finish(false, w);
        }
    }
    // ------------------------------------------------------- saturation
    if (matching === 'semantic' && stateMode === 'propositions') {
        for (const s of [0, 1]) {
            const pre = s === 0 ? 'P:' : 'D:';
            const byClass = new Map();
            aps[s].forEach(a => { const c = apClass.get(pre + a); byClass.set(c, [...(byClass.get(c) || []), a]); });
            for (const loc of tas[s].locations)
                for (const [, members] of byClass) {
                    const k = members.filter(m => loc.labels.includes(m)).length;
                    if (k > 0 && k < members.length)
                        return finish(false, {
                            kind: 'saturation', trace: [], countermodels: [],
                            message: `${s === 0 ? 'PT' : 'DT'} location '${loc.name}' asserts ${members.filter(m => loc.labels.includes(m)).join(', ')} but not the domain-equivalent ${members.filter(m => !loc.labels.includes(m)).join(', ')}`,
                        });
                }
        }
    }
    // ---------------------------------------------------------- clocks
    const nP = pt.clocks.length, nD = dt.clocks.length, dim = 1 + nP + nD;
    const clockIdx = [
        new Map(pt.clocks.map((c, k) => [c, 1 + k])), new Map(dt.clocks.map((c, k) => [c, 1 + nP + k]))
    ];
    const clockNames = ['0', ...pt.clocks.map(c => `PT.${c}`), ...dt.clocks.map(c => `DT.${c}`)];
    const M = new Array(dim).fill(0);
    [0, 1].forEach(s => (0, ta_1.maxConstants)(tas[s]).forEach((v, c) => (M[clockIdx[s].get(c)] = v)));
    const compile = (s, cs) => {
        const out = [];
        for (const c of cs) {
            const x = clockIdx[s].get(c.x);
            if (c.op === '<=' || c.op === '==')
                out.push({ i: x, j: 0, bound: (0, dbm_1.le)(c.c) });
            if (c.op === '<')
                out.push({ i: x, j: 0, bound: (0, dbm_1.lt)(c.c) });
            if (c.op === '>=' || c.op === '==')
                out.push({ i: 0, j: x, bound: (0, dbm_1.le)(-c.c) });
            if (c.op === '>')
                out.push({ i: 0, j: x, bound: (0, dbm_1.lt)(-c.c) });
        }
        return out;
    };
    const locInfo = [new Map(), new Map()];
    [0, 1].forEach(s => tas[s].locations.forEach(l => locInfo[s].set(l.name, { inv: compile(s, l.invariant), invSrc: l.invariant, labels: l.labels })));
    const out = [new Map(), new Map()];
    [0, 1].forEach(si => {
        const s = si;
        tas[s].locations.forEach(l => out[s].set(l.name, []));
        for (const e of tas[s].edges) {
            const resets = e.resets.map(r => clockIdx[s].get(r));
            let guard = compile(s, e.guard);
            for (const c of locInfo[s].get(e.to).inv) {
                const i = resets.includes(c.i) ? 0 : c.i, j = resets.includes(c.j) ? 0 : c.j;
                if (i === 0 && j === 0) {
                    if (c.bound < dbm_1.LE_ZERO) {
                        guard = null;
                        break;
                    }
                    continue;
                }
                guard.push({ i, j, bound: c.bound });
            }
            out[s].get(e.from).push({ edge: e, guard, resets, observable: isObs(s, e.label) });
        }
    });
    // ------------------------------------------------------ active clocks
    const active = [new Map(), new Map()];
    if (opts.activeClockReduction !== false) {
        [0, 1].forEach(si => {
            const s = si;
            const A_ = active[s];
            tas[s].locations.forEach(l => A_.set(l.name, new Set(locInfo[s].get(l.name).inv.map(c => c.i || c.j))));
            let changed = true;
            while (changed) {
                changed = false;
                for (const [l, ces] of out[s]) {
                    const set = A_.get(l);
                    for (const ce of ces) {
                        const add = [...compile(s, ce.edge.guard).map(c => c.i || c.j), ...Array.from(A_.get(ce.edge.to)).filter(x => !ce.resets.includes(x))];
                        for (const x of add)
                            if (!set.has(x)) {
                                set.add(x);
                                changed = true;
                            }
                    }
                }
            }
        });
    }
    const inactive = (p, d) => {
        if (opts.activeClockReduction === false)
            return [];
        const r = [];
        for (let x = 1; x < dim; x++) {
            const s = x <= nP ? 0 : 1;
            if (!active[s].get(s === 0 ? p : d).has(x))
                r.push(x);
        }
        return r;
    };
    // ------------------------------------------------- state consistency
    const condICache = new Map();
    const condI = (p, d) => {
        if (matching === 'syntactic' || opts.ignoreStates)
            return null;
        const k = `${p}\u0000${d}`;
        if (condICache.has(k))
            return condICache.get(k);
        if (stateMode === 'formula') {
            const r = stateEq.has(k) ? null
                : `PT location '${p}' and DT location '${d}' disagree on the state of the world: ${lifted(0, locInfo[0].get(p).labels)} vs ${lifted(1, locInfo[1].get(d).labels)}`;
            condICache.set(k, r);
            return r;
        }
        const cls = (s, l) => new Set(locInfo[s].get(l).labels.filter(a => aps[s].includes(a)).map(a => apClass.get((s === 0 ? 'P:' : 'D:') + a)));
        const cp = cls(0, p), cd = cls(1, d);
        const onlyP = locInfo[0].get(p).labels.filter(a => aps[0].includes(a) && !cd.has(apClass.get('P:' + a)));
        const onlyD = locInfo[1].get(d).labels.filter(a => aps[1].includes(a) && !cp.has(apClass.get('D:' + a)));
        const r = onlyP.length || onlyD.length
            ? `PT location '${p}' and DT location '${d}' disagree on the state of the world: ` +
                [onlyP.length ? `only PT asserts ${onlyP.map(a => `${a} := ${phi.pt.get(a)}`).join(', ')}` : '',
                    onlyD.length ? `only DT asserts ${onlyD.map(a => `${a} := ${phi.dt.get(a)}`).join(', ')}` : ''].filter(Boolean).join('; ')
            : null;
        condICache.set(k, r);
        return r;
    };
    // ---------------------------------------------------- matcher paths
    const universe = dbm_1.DBM.universe(dim);
    const pathCache = new Map();
    const computePre = (edges) => {
        let P = universe;
        for (let k = edges.length - 1; k >= 0 && P; k--) {
            const ce = edges[k];
            if (!ce.guard)
                return null;
            let Q = P.copy();
            for (const x of ce.resets) {
                if (!Q.constrain(x, 0, dbm_1.LE_ZERO) || !Q.constrain(0, x, dbm_1.LE_ZERO)) {
                    Q = null;
                    break;
                }
            }
            if (!Q)
                return null;
            for (const x of ce.resets)
                Q = Q.free(x);
            P = Q.and(ce.guard);
        }
        return P;
    };
    const matcherPaths = (s, loc, targets) => {
        const key = `${s}\u0000${loc}\u0000${targets ? Array.from(targets).sort().join(',') : '<tau>'}`;
        const hit = pathCache.get(key);
        if (hit)
            return hit;
        const res = [];
        const dfs = (l, prefix, visited) => {
            for (const ce of out[s].get(l)) {
                if (!ce.guard)
                    continue;
                if (ce.observable) {
                    if (targets && targets.has(ce.edge.label)) {
                        const edges = [...prefix, ce];
                        res.push({ edges, pre: computePre(edges), labels: edges.map(e => e.edge.label || 'τ') });
                    }
                }
                else if (prefix.length < maxTau && !visited.has(ce.edge.to)) {
                    const edges = [...prefix, ce];
                    if (!targets)
                        res.push({ edges, pre: computePre(edges), labels: edges.map(e => e.edge.label || 'τ') });
                    visited.add(ce.edge.to);
                    dfs(ce.edge.to, edges, visited);
                    visited.delete(ce.edge.to);
                }
            }
        };
        dfs(loc, [], new Set([loc]));
        const kept = res.filter(p => p.pre !== null);
        pathCache.set(key, kept);
        return kept;
    };
    // --------------------------------------------------- product graph
    const nodes = [];
    const index = new Map();
    const queue = [];
    const invOf = (s, l) => locInfo[s].get(l).inv;
    const getNode = (p, d, zpre) => {
        let bad;
        const msg = condI(p, d);
        if (msg)
            bad = { kind: 'state', message: msg };
        const delayed = zpre.up();
        if (!bad) {
            const dirs = mode === 'strong' ? [[0, 1], [1, 0]] : [[0, 1]];
            for (const [w, f] of dirs) {
                const U = delayed.and(invOf(w, w === 0 ? p : d));
                if (!U)
                    continue;
                const fl = f === 0 ? p : d;
                const invF = invOf(f, fl);
                const idx = invF.findIndex(c => !U.satisfies(c));
                if (idx >= 0) {
                    const c = invF[idx];
                    const viol = U.and([{ i: c.j, j: c.i, bound: (0, dbm_1.negateBound)(c.bound) }]);
                    const src = locInfo[f].get(fl).invSrc;
                    bad = {
                        kind: 'delay', clocks: viol.sample(),
                        message: `${w === 0 ? 'PT' : 'DT'} may still delay in '${w === 0 ? p : d}' but the ${f === 0 ? 'PT' : 'DT'} invariant of '${fl}' (${src.map(ta_1.constraintToString).join(' && ')}) forces it to leave: the delay is not matched (Condition IV)`,
                    };
                    break;
                }
            }
        }
        let z0 = delayed.and([...invOf(0, p), ...invOf(1, d)]);
        for (const x of inactive(p, d))
            z0 = z0.free(x);
        const z = z0.extrapolate(M);
        const key = `${p}\u0000${d}\u0000${z.key()}`;
        const found = index.get(key);
        if (found !== undefined)
            return found;
        const id = nodes.length;
        if (id >= maxNodes)
            throw new LimitError(`product exceeds ${maxNodes} symbolic states`);
        nodes.push({ id, loc: [p, d], zone: z, bad, obligations: [] });
        index.set(key, id);
        queue.push(id);
        return id;
    };
    const forward = (z, edges) => {
        let r = z;
        for (const ce of edges) {
            r = r.and(ce.guard);
            for (const x of ce.resets)
                r = r.reset(x);
        }
        return r;
    };
    const expand = (n) => {
        const movers = mode === 'strong' ? [0, 1] : [0];
        for (const s of movers) {
            const o = s === 0 ? 1 : 0;
            const myLoc = n.loc[s], otherLoc = n.loc[o];
            for (const ce of out[s].get(myLoc)) {
                if (!ce.guard)
                    continue;
                const cover = n.zone.and(ce.guard);
                if (!cover)
                    continue;
                const paths = [];
                if (ce.observable)
                    paths.push(...matcherPaths(o, otherLoc, (s === 0 ? E : Einv).get(ce.edge.label)));
                else
                    paths.push({ edges: [], pre: universe, labels: [] }, ...matcherPaths(o, otherLoc, null));
                const options = [];
                for (const path of paths) {
                    const pre = cover.intersect(path.pre);
                    if (!pre)
                        continue;
                    let z = forward(pre, path.edges);
                    for (const x of ce.resets)
                        z = z.reset(x);
                    const tgtOther = path.edges.length ? path.edges[path.edges.length - 1].edge.to : otherLoc;
                    const succ = s === 0 ? getNode(ce.edge.to, tgtOther, z) : getNode(tgtOther, ce.edge.to, z);
                    options.push({ pre, succ, path });
                }
                n.obligations.push({ mover: s, edge: ce, cover, options });
            }
        }
    };
    let limitHit = null;
    let init;
    try {
        init = getNode(pt.initial, dt.initial, dbm_1.DBM.zero(dim));
        while (queue.length) {
            const n = nodes[queue.shift()];
            if (!n.bad)
                expand(n);
        }
    }
    catch (e) {
        if (!(e instanceof LimitError))
            throw e;
        limitHit = e.message;
        init = 0;
    }
    stats.productNodes = nodes.length;
    if (limitHit)
        return finish(false, { kind: 'limit', message: limitHit, trace: [], countermodels: [] });
    // ------------------------------------------------ greatest fixpoint
    const alive = new Uint8Array(nodes.length);
    const preds = nodes.map(() => []);
    nodes.forEach(n => { if (!n.bad)
        alive[n.id] = 1; n.obligations.forEach(ob => ob.options.forEach(op => preds[op.succ].push(n.id))); });
    const reason = new Map();
    const work = nodes.filter(n => alive[n.id]).map(n => n.id);
    const inWork = new Uint8Array(nodes.length);
    work.forEach(i => (inWork[i] = 1));
    while (work.length) {
        const id = work.pop();
        inWork[id] = 0;
        if (!alive[id])
            continue;
        stats.fixpointEvaluations++;
        for (const ob of nodes[id].obligations) {
            const piece = (0, dbm_1.uncoveredPart)(ob.cover, ob.options.filter(op => alive[op.succ]).map(op => op.pre));
            if (piece) {
                alive[id] = 0;
                reason.set(id, { ob, piece });
                for (const p of preds[id])
                    if (alive[p] && !inWork[p]) {
                        inWork[p] = 1;
                        work.push(p);
                    }
                break;
            }
        }
    }
    stats.relationSize = alive.reduce((a, b) => a + b, 0);
    if (alive[init])
        return finish(true);
    // -------------------------------------------------------- witness
    const clockStr = (v) => (v ? v.map((x, k) => `${clockNames[k + 1]}=${fmt(x)}`).join(', ') : undefined);
    const contains = (z, v) => z.and(v.flatMap((x, k) => Number.isInteger(x)
        ? [{ i: k + 1, j: 0, bound: (0, dbm_1.le)(x) }, { i: 0, j: k + 1, bound: (0, dbm_1.le)(-x) }]
        : [{ i: k + 1, j: 0, bound: (0, dbm_1.lt)(Math.ceil(x)) }, { i: 0, j: k + 1, bound: (0, dbm_1.lt)(-Math.floor(x)) }])) !== null;
    const trace = [];
    const visited = new Set();
    let cur = init;
    let w;
    while (!w) {
        visited.add(cur);
        const n = nodes[cur];
        if (n.bad) {
            trace.push({ pt: n.loc[0], dt: n.loc[1], clocks: clockStr(n.bad.clocks) });
            w = { kind: n.bad.kind, message: n.bad.message, trace, countermodels: [] };
            break;
        }
        const r = reason.get(cur);
        const v = r.piece.sample();
        const who = r.ob.mover === 0 ? 'PT' : 'DT';
        const lab = r.ob.edge.edge.label || 'τ';
        trace.push({ pt: n.loc[0], dt: n.loc[1], move: `${who} ${r.ob.edge.observable ? 'event' : 'internal step'} ${lab}`, clocks: clockStr(v) });
        const next = r.ob.options.find(op => !alive[op.succ] && !visited.has(op.succ) && contains(op.pre, v));
        if (next) {
            cur = next.succ;
            continue;
        }
        const other = r.ob.mover === 0 ? 'DT' : 'PT';
        w = {
            kind: r.ob.edge.observable ? 'event' : 'internal', trace, countermodels: [],
            message: r.ob.edge.observable
                ? `${who} event '${lab}' (from '${n.loc[r.ob.mover]}' to '${r.ob.edge.edge.to}') has no domain-equivalent ${other} move from '${n.loc[1 - r.ob.mover]}' at ${clockStr(v)}`
                : `${who} internal step from '${n.loc[r.ob.mover]}' leads to a state the ${other} cannot match`,
        };
        if (r.ob.edge.observable && matching === 'semantic') {
            // explain with countermodels against the candidate moves of the other twin
            const o = r.ob.mover === 0 ? 1 : 0;
            const cands = new Set();
            const closure = [n.loc[o]];
            for (let k = 0; k < closure.length && k < 50; k++)
                for (const ce of out[o].get(closure[k])) {
                    if (!(0, ta_1.isInternalLabel)(ce.edge.label))
                        cands.add(ce.edge.label);
                    if (!ce.observable && !closure.includes(ce.edge.to))
                        closure.push(ce.edge.to);
                }
            const mine = interp(r.ob.mover).get(lab);
            const qs = [];
            const uninterpreted = [];
            cands.forEach(c => {
                const f = interp(o).get(c);
                if ((0, ontology_1.isTau)(f)) {
                    uninterpreted.push(c);
                    return;
                }
                qs.push({ id: c, assertions: [`(not (= ${mine} ${f}))`], wantModel: true });
            });
            const ans = smt(qs);
            ans.forEach((a, c) => {
                if (a.status !== 'sat')
                    return;
                const ptL = r.ob.mover === 0 ? lab : c, dtL = r.ob.mover === 0 ? c : lab;
                w.countermodels.push({ pt: ptL, dt: dtL, ptMeaning: phi.pt.get(ptL), dtMeaning: phi.dt.get(dtL), model: relevantModel(a.model, [phi.pt.get(ptL), phi.dt.get(dtL)]) });
            });
            if (uninterpreted.length)
                w.message += `; candidate ${other} label(s) ${uninterpreted.join(', ')} have no interpretation and are treated as internal (τ)`;
            else if (w.countermodels.length)
                w.message += `; the candidate ${other} labels denote different domain conditions (see countermodels)`;
        }
    }
    return finish(false, w);
}
exports.checkAlignment = checkAlignment;
class LimitError extends Error {
}
//# sourceMappingURL=checker.js.map