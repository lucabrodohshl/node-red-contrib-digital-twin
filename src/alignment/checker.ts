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
import { DBM, DiffConstraint, LE_ZERO, le, lt, negateBound, uncoveredPart } from './dbm';
import { ClockConstraint, Edge, TimedAutomaton, constraintToString, isInternalLabel, maxConstants } from './ta';
import { DomainKnowledge, isTau, smtPreamble } from './ontology';
import { SmtQuery, runSmtBatch, tokenize } from './smt';

export type AlignmentMode = 'strong' | 'weak';
export type Matching = 'semantic' | 'syntactic';

export interface AlignmentOptions {
    mode?: AlignmentMode;
    matching?: Matching;
    /** Bisimulation-critical PT events (D_safe): each needs exactly one DT counterpart. */
    critical?: string[];
    maxTau?: number;
    maxNodes?: number;
    z3Path?: string;
    /**
     * 'propositions' (default): Condition I as equality of the sets of domain-equivalence
     * classes of the propositions, plus saturation.
     * 'formula': Condition I as Delta |= I_P^(L(p)) <-> I_D^(L(d)) on lifted interpretations
     * (suits views whose state meaning is attached to whole locations, e.g. UPPAAL imports).
     */
    stateMode?: 'propositions' | 'formula';
    /** Diagnostic only: skip Condition I (state consistency), i.e. match events and delays only. */
    ignoreStates?: boolean;
    /** Free clocks that are reset before being read again (sound state-space reduction). */
    activeClockReduction?: boolean;
}

export interface TraceStep { pt: string; dt: string; move?: string; clocks?: string; }

export interface Witness {
    kind: 'criticality' | 'saturation' | 'state' | 'delay' | 'event' | 'internal' | 'limit';
    message: string;
    trace: TraceStep[];
    countermodels: Array<{ pt: string; dt: string; ptMeaning: string; dtMeaning: string; model: Record<string, string> }>;
}

export interface AlignmentStats {
    smtCalls: number;
    labelPairsInE: number;
    apClasses: number;
    productNodes: number;
    relationSize: number;
    fixpointEvaluations: number;
    timeMs: number;
    smtTimeMs: number;
}

export interface AlignmentResult {
    aligned: boolean;
    mode: AlignmentMode;
    matching: Matching;
    witness?: Witness;
    labelEquivalence: Array<{ pt: string; dt: string }>;
    propositionEquivalence: Array<{ pt: string; dt: string }>;
    internal: { pt: string[]; dt: string[] };
    stats: AlignmentStats;
}

type Side = 0 | 1; // 0 = PT, 1 = DT

interface CEdge {
    edge: Edge;
    guard: DiffConstraint[] | null; // effective guard incl. target invariant; null = never enabled
    resets: number[];
    observable: boolean;
}

interface Path { edges: CEdge[]; pre: DBM | null; labels: string[]; }

interface Option { pre: DBM; succ: number; path: Path; }

interface Obligation { mover: Side; edge: CEdge; cover: DBM; options: Option[]; }

interface PNode {
    id: number;
    loc: [string, string];
    zone: DBM;
    bad?: { kind: 'state' | 'delay'; message: string; clocks?: number[] };
    obligations: Obligation[];
}

/** Keeps the model entries for symbols that occur in the compared formulas. */
function relevantModel(model: Record<string, string> | undefined, formulas: string[]): Record<string, string> {
    if (!model) return {};
    const syms = new Set(([] as string[]).concat(...formulas.map(f => tokenize(f))));
    const r: Record<string, string> = {};
    Object.keys(model).filter(k => syms.has(k)).sort().forEach(k => (r[k] = model[k]));
    return Object.keys(r).length ? r : model;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, ''));

export function checkAlignment(pt: TimedAutomaton, dt: TimedAutomaton, phi: DomainKnowledge | null, opts: AlignmentOptions = {}): AlignmentResult {
    const t0 = Date.now();
    const mode: AlignmentMode = opts.mode || 'strong';
    const matching: Matching = opts.matching || 'semantic';
    const maxTau = opts.maxTau ?? 2;
    const maxNodes = opts.maxNodes ?? 500000;
    const stateMode = opts.stateMode || 'propositions';
    if (matching === 'semantic' && !phi) throw new Error('semantic matching requires domain knowledge');
    const tas: [TimedAutomaton, TimedAutomaton] = [pt, dt];
    const stats: AlignmentStats = { smtCalls: 0, labelPairsInE: 0, apClasses: 0, productNodes: 0, relationSize: 0, fixpointEvaluations: 0, timeMs: 0, smtTimeMs: 0 };

    // ------------------------------------------------ labels & interpretation
    const interp = (s: Side) => (s === 0 ? phi?.pt : phi?.dt);
    const eventsOf = (ta: TimedAutomaton) => Array.from(new Set(ta.edges.map(e => e.label).filter(l => !isInternalLabel(l))));
    const apsOf = (ta: TimedAutomaton) => Array.from(new Set(([] as string[]).concat(...ta.locations.map(l => l.labels))));
    const isObs = (s: Side, label: string) => !isInternalLabel(label) && (matching === 'syntactic' || !isTau(interp(s)!.get(label)));
    const events: [string[], string[]] = [eventsOf(pt).filter(l => isObs(0, l)), eventsOf(dt).filter(l => isObs(1, l))];
    const internal = { pt: eventsOf(pt).filter(l => !isObs(0, l)), dt: eventsOf(dt).filter(l => !isObs(1, l)) };
    let aps: [string[], string[]] = [[], []];

    const E = new Map<string, Set<string>>();     // PT event -> DT events
    const Einv = new Map<string, Set<string>>();  // DT event -> PT events
    events[0].forEach(a => E.set(a, new Set()));
    events[1].forEach(a => Einv.set(a, new Set()));
    const apClass = new Map<string, number>();    // 'P:ap' / 'D:ap' -> class id
    const stateEq = new Set<string>();            // location pairs with equivalent lifted interpretations
    const lifted = (s: Side, labels: string[]): string => {
        const fs_ = labels.map(a => interp(s)!.get(a)).filter(f => !isTau(f)) as string[];
        return fs_.length === 0 ? 'true' : fs_.length === 1 ? fs_[0] : `(and ${fs_.join(' ')})`;
    };

    const preamble = phi ? smtPreamble(phi.ontology) : '';
    const base = phi ? phi.ontology.axioms.map(a => a.formula) : [];
    const smt = (qs: SmtQuery[]) => {
        const ts = Date.now();
        const r = runSmtBatch(preamble, base, qs, opts.z3Path);
        stats.smtCalls += qs.length;
        stats.smtTimeMs += Date.now() - ts;
        return r;
    };

    if (matching === 'syntactic') {
        for (const a of events[0]) if (events[1].includes(a)) { E.get(a)!.add(a); Einv.get(a)!.add(a); }
    } else {
        const Ip = phi!.pt, Id = phi!.dt;
        const apCand: [string[], string[]] = stateMode === 'formula' ? [[], []] : [apsOf(pt).filter(a => !isTau(Ip.get(a))), apsOf(dt).filter(a => !isTau(Id.get(a)))];
        // drop propositions that are valid under Delta: they carry no domain information
        const tq: SmtQuery[] = [];
        apCand.forEach((l, s) => l.forEach(a => tq.push({ id: `${s}:${a}`, assertions: [`(not ${interp(s as Side)!.get(a)})`] })));
        const tr = smt(tq);
        aps = [apCand[0].filter(a => tr.get(`0:${a}`)!.status !== 'unsat'), apCand[1].filter(a => tr.get(`1:${a}`)!.status !== 'unsat')];

        const queries: SmtQuery[] = [];
        const pairs: Array<() => void> = [];
        const cache = new Map<string, string>();
        const equivQuery = (f: string, g: string): string | null => {
            if (f === g) return null; // syntactically identical: trivially equivalent
            const k = f < g ? `${f}\u0000${g}` : `${g}\u0000${f}`;
            if (!cache.has(k)) { const id = `q${cache.size}`; cache.set(k, id); queries.push({ id, assertions: [`(not (= ${f} ${g}))`] }); }
            return cache.get(k)!;
        };
        const deferred: Array<{ id: string | null; then: () => void }> = [];
        for (const a of events[0]) for (const b of events[1])
            deferred.push({ id: equivQuery(Ip.get(a)!, Id.get(b)!), then: () => { E.get(a)!.add(b); Einv.get(b)!.add(a); } });
        // union-find over all propositions of both twins
        const nodes = [...aps[0].map(a => `P:${a}`), ...aps[1].map(a => `D:${a}`)];
        const parent = new Map(nodes.map(n => [n, n]));
        const find = (x: string): string => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
        const union = (x: string, y: string) => parent.set(find(x), find(y));
        const fOf = (n: string) => (n[0] === 'P' ? Ip : Id).get(n.slice(2))!;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
            const x = nodes[i], y = nodes[j];
            deferred.push({ id: equivQuery(fOf(x), fOf(y)), then: () => union(x, y) });
        }
        if (stateMode === 'formula') {
            for (const lp of pt.locations) for (const ld of dt.locations) {
                const fp = lifted(0, lp.labels), fd = lifted(1, ld.labels);
                const key = `${lp.name}\u0000${ld.name}`;
                deferred.push({ id: equivQuery(fp, fd), then: () => stateEq.add(key) });
            }
        }
        const res = smt(queries);
        for (const d of deferred) if (d.id === null || res.get(d.id)!.status === 'unsat') d.then();
        void pairs;
        const roots = new Map<string, number>();
        for (const n of nodes) { const r = find(n); if (!roots.has(r)) roots.set(r, roots.size); apClass.set(n, roots.get(r)!); }
        stats.apClasses = roots.size;
    }
    E.forEach(s => (stats.labelPairsInE += s.size));
    const labelEquivalence: Array<{ pt: string; dt: string }> = [];
    E.forEach((s, a) => s.forEach(b => labelEquivalence.push({ pt: a, dt: b })));
    const propositionEquivalence: Array<{ pt: string; dt: string }> = [];
    for (const a of aps[0]) for (const b of aps[1]) if (apClass.get(`P:${a}`) === apClass.get(`D:${b}`)) propositionEquivalence.push({ pt: a, dt: b });

    const finish = (aligned: boolean, witness?: Witness): AlignmentResult => {
        stats.timeMs = Date.now() - t0;
        return { aligned, mode, matching, witness, labelEquivalence, propositionEquivalence, internal, stats };
    };

    // --------------------------------------------- bisimulation-criticality
    for (const a of opts.critical || []) {
        const m = E.get(a);
        const n = m ? m.size : 0;
        if (n !== 1) {
            const w: Witness = {
                kind: 'criticality', trace: [], countermodels: [],
                message: `critical PT event '${a}' has ${n} domain-equivalent DT events${n ? ` (${Array.from(m!).join(', ')})` : ''}; exactly one is required`,
            };
            if (n === 0 && matching === 'semantic' && phi!.pt.get(a)) {
                const fa = phi!.pt.get(a)!;
                const symsA = new Set(tokenize(fa).filter(t => phi!.ontology.functions.some(f => f.name === t)));
                const cands = eventsOf(dt).filter(b => isObs(1, b) && tokenize(phi!.dt.get(b)!).some(t => symsA.has(t)));
                const ans = smt(cands.map(b => ({ id: b, assertions: [`(not (= ${fa} ${phi!.dt.get(b)}))`], wantModel: true })));
                ans.forEach((r, b) => { if (r.status === 'sat') w.countermodels.push({ pt: a, dt: b, ptMeaning: fa, dtMeaning: phi!.dt.get(b)!, model: relevantModel(r.model, [fa, phi!.dt.get(b)!]) }); });
                if (w.countermodels.length) w.message += `; closest DT candidate(s) ${w.countermodels.map(c => c.dt).join(', ')} denote a different condition (see countermodel)`;
                else if (internal.dt.length) w.message += `; DT label(s) without interpretation (treated as internal τ): ${internal.dt.join(', ')}`;
            }
            return finish(false, w);
        }
    }

    // ------------------------------------------------------- saturation
    if (matching === 'semantic' && stateMode === 'propositions') {
        for (const s of [0, 1] as Side[]) {
            const pre = s === 0 ? 'P:' : 'D:';
            const byClass = new Map<number, string[]>();
            aps[s].forEach(a => { const c = apClass.get(pre + a)!; byClass.set(c, [...(byClass.get(c) || []), a]); });
            for (const loc of tas[s].locations) for (const [, members] of byClass) {
                const k = members.filter(m => loc.labels.includes(m)).length;
                if (k > 0 && k < members.length) return finish(false, {
                    kind: 'saturation', trace: [], countermodels: [],
                    message: `${s === 0 ? 'PT' : 'DT'} location '${loc.name}' asserts ${members.filter(m => loc.labels.includes(m)).join(', ')} but not the domain-equivalent ${members.filter(m => !loc.labels.includes(m)).join(', ')}`,
                });
            }
        }
    }

    // ---------------------------------------------------------- clocks
    const nP = pt.clocks.length, nD = dt.clocks.length, dim = 1 + nP + nD;
    const clockIdx: [Map<string, number>, Map<string, number>] = [
        new Map(pt.clocks.map((c, k) => [c, 1 + k])), new Map(dt.clocks.map((c, k) => [c, 1 + nP + k]))];
    const clockNames = ['0', ...pt.clocks.map(c => `PT.${c}`), ...dt.clocks.map(c => `DT.${c}`)];
    const M: number[] = new Array(dim).fill(0);
    [0, 1].forEach(s => maxConstants(tas[s]).forEach((v, c) => (M[clockIdx[s].get(c)!] = v)));
    const compile = (s: Side, cs: ClockConstraint[]): DiffConstraint[] => {
        const out: DiffConstraint[] = [];
        for (const c of cs) {
            const x = clockIdx[s].get(c.x)!;
            if (c.op === '<=' || c.op === '==') out.push({ i: x, j: 0, bound: le(c.c) });
            if (c.op === '<') out.push({ i: x, j: 0, bound: lt(c.c) });
            if (c.op === '>=' || c.op === '==') out.push({ i: 0, j: x, bound: le(-c.c) });
            if (c.op === '>') out.push({ i: 0, j: x, bound: lt(-c.c) });
        }
        return out;
    };
    const locInfo: [Map<string, { inv: DiffConstraint[]; invSrc: ClockConstraint[]; labels: string[] }>, Map<string, { inv: DiffConstraint[]; invSrc: ClockConstraint[]; labels: string[] }>] = [new Map(), new Map()];
    [0, 1].forEach(s => tas[s].locations.forEach(l => locInfo[s].set(l.name, { inv: compile(s as Side, l.invariant), invSrc: l.invariant, labels: l.labels })));
    const out: [Map<string, CEdge[]>, Map<string, CEdge[]>] = [new Map(), new Map()];
    [0, 1].forEach(si => {
        const s = si as Side;
        tas[s].locations.forEach(l => out[s].set(l.name, []));
        for (const e of tas[s].edges) {
            const resets = e.resets.map(r => clockIdx[s].get(r)!);
            let guard: DiffConstraint[] | null = compile(s, e.guard);
            for (const c of locInfo[s].get(e.to)!.inv) {
                const i = resets.includes(c.i) ? 0 : c.i, j = resets.includes(c.j) ? 0 : c.j;
                if (i === 0 && j === 0) { if (c.bound < LE_ZERO) { guard = null; break; } continue; }
                guard.push({ i, j, bound: c.bound });
            }
            out[s].get(e.from)!.push({ edge: e, guard, resets, observable: isObs(s, e.label) });
        }
    });

    // ------------------------------------------------------ active clocks
    const active: [Map<string, Set<number>>, Map<string, Set<number>>] = [new Map(), new Map()];
    if (opts.activeClockReduction !== false) {
        [0, 1].forEach(si => {
            const s = si as Side;
            const A_ = active[s];
            tas[s].locations.forEach(l => A_.set(l.name, new Set(locInfo[s].get(l.name)!.inv.map(c => c.i || c.j))));
            let changed = true;
            while (changed) {
                changed = false;
                for (const [l, ces] of out[s]) {
                    const set = A_.get(l)!;
                    for (const ce of ces) {
                        const add = [...compile(s, ce.edge.guard).map(c => c.i || c.j), ...Array.from(A_.get(ce.edge.to)!).filter(x => !ce.resets.includes(x))];
                        for (const x of add) if (!set.has(x)) { set.add(x); changed = true; }
                    }
                }
            }
        });
    }
    const inactive = (p: string, d: string): number[] => {
        if (opts.activeClockReduction === false) return [];
        const r: number[] = [];
        for (let x = 1; x < dim; x++) {
            const s: Side = x <= nP ? 0 : 1;
            if (!active[s].get(s === 0 ? p : d)!.has(x)) r.push(x);
        }
        return r;
    };

    // ------------------------------------------------- state consistency
    const condICache = new Map<string, string | null>();
    const condI = (p: string, d: string): string | null => {
        if (matching === 'syntactic' || opts.ignoreStates) return null;
        const k = `${p}\u0000${d}`;
        if (condICache.has(k)) return condICache.get(k)!;
        if (stateMode === 'formula') {
            const r = stateEq.has(k) ? null
                : `PT location '${p}' and DT location '${d}' disagree on the state of the world: ${lifted(0, locInfo[0].get(p)!.labels)} vs ${lifted(1, locInfo[1].get(d)!.labels)}`;
            condICache.set(k, r);
            return r;
        }
        const cls = (s: Side, l: string) => new Set(locInfo[s].get(l)!.labels.filter(a => aps[s].includes(a)).map(a => apClass.get((s === 0 ? 'P:' : 'D:') + a)!));
        const cp = cls(0, p), cd = cls(1, d);
        const onlyP = locInfo[0].get(p)!.labels.filter(a => aps[0].includes(a) && !cd.has(apClass.get('P:' + a)!));
        const onlyD = locInfo[1].get(d)!.labels.filter(a => aps[1].includes(a) && !cp.has(apClass.get('D:' + a)!));
        const r = onlyP.length || onlyD.length
            ? `PT location '${p}' and DT location '${d}' disagree on the state of the world: ` +
              [onlyP.length ? `only PT asserts ${onlyP.map(a => `${a} := ${phi!.pt.get(a)}`).join(', ')}` : '',
               onlyD.length ? `only DT asserts ${onlyD.map(a => `${a} := ${phi!.dt.get(a)}`).join(', ')}` : ''].filter(Boolean).join('; ')
            : null;
        condICache.set(k, r);
        return r;
    };

    // ---------------------------------------------------- matcher paths
    const universe = DBM.universe(dim);
    const pathCache = new Map<string, Path[]>();
    const computePre = (edges: CEdge[]): DBM | null => {
        let P: DBM | null = universe;
        for (let k = edges.length - 1; k >= 0 && P; k--) {
            const ce = edges[k];
            if (!ce.guard) return null;
            let Q: DBM | null = P.copy();
            for (const x of ce.resets) {
                if (!Q.constrain(x, 0, LE_ZERO) || !Q.constrain(0, x, LE_ZERO)) { Q = null; break; }
            }
            if (!Q) return null;
            for (const x of ce.resets) Q = Q.free(x);
            P = Q.and(ce.guard);
        }
        return P;
    };
    const matcherPaths = (s: Side, loc: string, targets: Set<string> | null): Path[] => {
        const key = `${s}\u0000${loc}\u0000${targets ? Array.from(targets).sort().join(',') : '<tau>'}`;
        const hit = pathCache.get(key);
        if (hit) return hit;
        const res: Path[] = [];
        const dfs = (l: string, prefix: CEdge[], visited: Set<string>) => {
            for (const ce of out[s].get(l)!) {
                if (!ce.guard) continue;
                if (ce.observable) {
                    if (targets && targets.has(ce.edge.label)) {
                        const edges = [...prefix, ce];
                        res.push({ edges, pre: computePre(edges), labels: edges.map(e => e.edge.label || 'τ') });
                    }
                } else if (prefix.length < maxTau && !visited.has(ce.edge.to)) {
                    const edges = [...prefix, ce];
                    if (!targets) res.push({ edges, pre: computePre(edges), labels: edges.map(e => e.edge.label || 'τ') });
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
    const nodes: PNode[] = [];
    const index = new Map<string, number>();
    const queue: number[] = [];
    const invOf = (s: Side, l: string) => locInfo[s].get(l)!.inv;
    const getNode = (p: string, d: string, zpre: DBM): number => {
        let bad: PNode['bad'];
        const msg = condI(p, d);
        if (msg) bad = { kind: 'state', message: msg };
        const delayed = zpre.up();
        if (!bad) {
            const dirs: Array<[Side, Side]> = mode === 'strong' ? [[0, 1], [1, 0]] : [[0, 1]];
            for (const [w, f] of dirs) {
                const U = delayed.and(invOf(w, w === 0 ? p : d));
                if (!U) continue;
                const fl = f === 0 ? p : d;
                const invF = invOf(f, fl);
                const idx = invF.findIndex(c => !U.satisfies(c));
                if (idx >= 0) {
                    const c = invF[idx];
                    const viol = U.and([{ i: c.j, j: c.i, bound: negateBound(c.bound) }])!;
                    const src = locInfo[f].get(fl)!.invSrc;
                    bad = {
                        kind: 'delay', clocks: viol.sample(),
                        message: `${w === 0 ? 'PT' : 'DT'} may still delay in '${w === 0 ? p : d}' but the ${f === 0 ? 'PT' : 'DT'} invariant of '${fl}' (${src.map(constraintToString).join(' && ')}) forces it to leave: the delay is not matched (Condition IV)`,
                    };
                    break;
                }
            }
        }
        let z0 = delayed.and([...invOf(0, p), ...invOf(1, d)])!;
        for (const x of inactive(p, d)) z0 = z0.free(x);
        const z = z0.extrapolate(M);
        const key = `${p}\u0000${d}\u0000${z.key()}`;
        const found = index.get(key);
        if (found !== undefined) return found;
        const id = nodes.length;
        if (id >= maxNodes) throw new LimitError(`product exceeds ${maxNodes} symbolic states`);
        nodes.push({ id, loc: [p, d], zone: z, bad, obligations: [] });
        index.set(key, id);
        queue.push(id);
        return id;
    };

    const forward = (z: DBM, edges: CEdge[]): DBM => {
        let r: DBM = z;
        for (const ce of edges) {
            r = r.and(ce.guard!)!;
            for (const x of ce.resets) r = r.reset(x);
        }
        return r;
    };

    const expand = (n: PNode) => {
        const movers: Side[] = mode === 'strong' ? [0, 1] : [0];
        for (const s of movers) {
            const o: Side = s === 0 ? 1 : 0;
            const myLoc = n.loc[s], otherLoc = n.loc[o];
            for (const ce of out[s].get(myLoc)!) {
                if (!ce.guard) continue;
                const cover = n.zone.and(ce.guard);
                if (!cover) continue;
                const paths: Path[] = [];
                if (ce.observable) paths.push(...matcherPaths(o, otherLoc, (s === 0 ? E : Einv).get(ce.edge.label)!));
                else paths.push({ edges: [], pre: universe, labels: [] }, ...matcherPaths(o, otherLoc, null));
                const options: Option[] = [];
                for (const path of paths) {
                    const pre = cover.intersect(path.pre!);
                    if (!pre) continue;
                    let z = forward(pre, path.edges);
                    for (const x of ce.resets) z = z.reset(x);
                    const tgtOther = path.edges.length ? path.edges[path.edges.length - 1].edge.to : otherLoc;
                    const succ = s === 0 ? getNode(ce.edge.to, tgtOther, z) : getNode(tgtOther, ce.edge.to, z);
                    options.push({ pre, succ, path });
                }
                n.obligations.push({ mover: s, edge: ce, cover, options });
            }
        }
    };

    let limitHit: string | null = null;
    let init: number;
    try {
        init = getNode(pt.initial, dt.initial, DBM.zero(dim));
        while (queue.length) {
            const n = nodes[queue.shift()!];
            if (!n.bad) expand(n);
        }
    } catch (e) {
        if (!(e instanceof LimitError)) throw e;
        limitHit = e.message;
        init = 0;
    }
    stats.productNodes = nodes.length;
    if (limitHit) return finish(false, { kind: 'limit', message: limitHit, trace: [], countermodels: [] });

    // ------------------------------------------------ greatest fixpoint
    const alive = new Uint8Array(nodes.length);
    const preds: number[][] = nodes.map(() => []);
    nodes.forEach(n => { if (!n.bad) alive[n.id] = 1; n.obligations.forEach(ob => ob.options.forEach(op => preds[op.succ].push(n.id))); });
    const reason = new Map<number, { ob: Obligation; piece: DBM }>();
    const work: number[] = nodes.filter(n => alive[n.id]).map(n => n.id);
    const inWork = new Uint8Array(nodes.length);
    work.forEach(i => (inWork[i] = 1));
    while (work.length) {
        const id = work.pop()!;
        inWork[id] = 0;
        if (!alive[id]) continue;
        stats.fixpointEvaluations++;
        for (const ob of nodes[id].obligations) {
            const piece = uncoveredPart(ob.cover, ob.options.filter(op => alive[op.succ]).map(op => op.pre));
            if (piece) {
                alive[id] = 0;
                reason.set(id, { ob, piece });
                for (const p of preds[id]) if (alive[p] && !inWork[p]) { inWork[p] = 1; work.push(p); }
                break;
            }
        }
    }
    stats.relationSize = alive.reduce((a, b) => a + b, 0);
    if (alive[init]) return finish(true);

    // -------------------------------------------------------- witness
    const clockStr = (v: number[] | undefined) => (v ? v.map((x, k) => `${clockNames[k + 1]}=${fmt(x)}`).join(', ') : undefined);
    const contains = (z: DBM, v: number[]) => z.and(v.flatMap((x, k) => Number.isInteger(x)
        ? [{ i: k + 1, j: 0, bound: le(x) }, { i: 0, j: k + 1, bound: le(-x) }]
        : [{ i: k + 1, j: 0, bound: lt(Math.ceil(x)) }, { i: 0, j: k + 1, bound: lt(-Math.floor(x)) }])) !== null;
    const trace: TraceStep[] = [];
    const visited = new Set<number>();
    let cur = init;
    let w: Witness | undefined;
    while (!w) {
        visited.add(cur);
        const n = nodes[cur];
        if (n.bad) {
            trace.push({ pt: n.loc[0], dt: n.loc[1], clocks: clockStr(n.bad.clocks) });
            w = { kind: n.bad.kind, message: n.bad.message, trace, countermodels: [] };
            break;
        }
        const r = reason.get(cur)!;
        const v = r.piece.sample();
        const who = r.ob.mover === 0 ? 'PT' : 'DT';
        const lab = r.ob.edge.edge.label || 'τ';
        trace.push({ pt: n.loc[0], dt: n.loc[1], move: `${who} ${r.ob.edge.observable ? 'event' : 'internal step'} ${lab}`, clocks: clockStr(v) });
        const next = r.ob.options.find(op => !alive[op.succ] && !visited.has(op.succ) && contains(op.pre, v));
        if (next) { cur = next.succ; continue; }
        const other = r.ob.mover === 0 ? 'DT' : 'PT';
        w = {
            kind: r.ob.edge.observable ? 'event' : 'internal', trace, countermodels: [],
            message: r.ob.edge.observable
                ? `${who} event '${lab}' (from '${n.loc[r.ob.mover]}' to '${r.ob.edge.edge.to}') has no domain-equivalent ${other} move from '${n.loc[1 - r.ob.mover]}' at ${clockStr(v)}`
                : `${who} internal step from '${n.loc[r.ob.mover]}' leads to a state the ${other} cannot match`,
        };
        if (r.ob.edge.observable && matching === 'semantic') {
            // explain with countermodels against the candidate moves of the other twin
            const o: Side = r.ob.mover === 0 ? 1 : 0;
            const cands = new Set<string>();
            const closure = [n.loc[o]];
            for (let k = 0; k < closure.length && k < 50; k++)
                for (const ce of out[o].get(closure[k])!) {
                    if (!isInternalLabel(ce.edge.label)) cands.add(ce.edge.label);
                    if (!ce.observable && !closure.includes(ce.edge.to)) closure.push(ce.edge.to);
                }
            const mine = interp(r.ob.mover)!.get(lab)!;
            const qs: SmtQuery[] = [];
            const uninterpreted: string[] = [];
            cands.forEach(c => {
                const f = interp(o)!.get(c);
                if (isTau(f)) { uninterpreted.push(c); return; }
                qs.push({ id: c, assertions: [`(not (= ${mine} ${f}))`], wantModel: true });
            });
            const ans = smt(qs);
            ans.forEach((a, c) => {
                if (a.status !== 'sat') return;
                const ptL = r.ob.mover === 0 ? lab : c, dtL = r.ob.mover === 0 ? c : lab;
                w!.countermodels.push({ pt: ptL, dt: dtL, ptMeaning: phi!.pt.get(ptL)!, dtMeaning: phi!.dt.get(dtL)!, model: relevantModel(a.model, [phi!.pt.get(ptL)!, phi!.dt.get(dtL)!]) });
            });
            if (uninterpreted.length) w.message += `; candidate ${other} label(s) ${uninterpreted.join(', ')} have no interpretation and are treated as internal (τ)`;
            else if (w.countermodels.length) w.message += `; the candidate ${other} labels denote different domain conditions (see countermodels)`;
        }
    }
    return finish(false, w);
}

class LimitError extends Error {}
