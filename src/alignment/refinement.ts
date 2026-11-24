/**
 * Knowledge refinement Phi_new ⊑ Phi_old (conditions (a)-(c) in
 * docs/semantic-alignment.md).  When it holds, an alignment established under
 * Phi_old is preserved under Phi_new and need not be recomputed.
 */
import { DomainKnowledge, isTau, smtPreamble } from './ontology';
import { SmtQuery, runSmtBatch, tokenize } from './smt';

const keep = (m: Record<string, string> | undefined, fs: string[]) => {
    if (!m) return m;
    const syms = new Set(([] as string[]).concat(...fs.map(f => tokenize(f))));
    const r: Record<string, string> = {};
    Object.keys(m).filter(k => syms.has(k)).forEach(k => (r[k] = m[k]));
    return Object.keys(r).length ? r : m;
};

export interface RefinementViolation {
    condition: 'a' | 'b' | 'c';
    item: string;
    detail: string;
    countermodel?: Record<string, string>;
}

export interface RefinementResult { holds: boolean; violations: RefinementViolation[]; smtCalls: number; timeMs: number; }

export function checkKnowledgeRefinement(phiNew: DomainKnowledge, phiOld: DomainKnowledge, z3Path?: string): RefinementResult {
    const t0 = Date.now();
    const v: RefinementViolation[] = [];
    const Kn = phiNew.ontology, Ko = phiOld.ontology;
    // (a) signature inclusion, shared symbols keep their sorts
    for (const [s] of Ko.sorts) if (!Kn.sorts.has(s)) v.push({ condition: 'a', item: `sort ${s}`, detail: 'removed in the new ontology' });
    for (const f of Ko.functions) {
        const g = Kn.functions.find(h => h.name === f.name);
        if (!g) v.push({ condition: 'a', item: f.name, detail: 'symbol removed in the new ontology' });
        else if (g.ret !== f.ret || g.args.join() !== f.args.join()) v.push({ condition: 'a', item: f.name, detail: 'signature changed' });
    }
    if (v.length) return { holds: false, violations: v, smtCalls: 0, timeMs: Date.now() - t0 };

    const qs: SmtQuery[] = [];
    // (b) Delta_new |= Delta_old
    for (const ax of Ko.axioms) qs.push({ id: `b\u0000${ax.name}`, assertions: [`(not ${ax.formula})`], wantModel: true });
    // (c) labels keep their meaning (and their internal/observable status)
    for (const [tw, In, Io] of [['PT', phiNew.pt, phiOld.pt], ['DT', phiNew.dt, phiOld.dt]] as const) {
        for (const x of new Set([...In.keys(), ...Io.keys()])) {
            const fn = In.get(x), fo = Io.get(x);
            if (isTau(fn) !== isTau(fo)) { v.push({ condition: 'c', item: `${tw}:${x}`, detail: `internal/observable status changed` }); continue; }
            if (isTau(fn) || fn === fo) continue;
            qs.push({ id: `c\u0000${tw}:${x}`, assertions: [`(not (= ${fn} ${fo}))`], wantModel: true });
        }
    }
    const res = runSmtBatch(smtPreamble(Kn), Kn.axioms.map(a => a.formula), qs, z3Path);
    for (const q of qs) {
        const a = res.get(q.id)!;
        if (a.status === 'unsat') continue;
        const [cond, item] = q.id.split('\u0000');
        if (cond === 'b') v.push({ condition: 'b', item, detail: `axiom '${item}' of the old ontology is not entailed by the new axioms`, countermodel: keep(a.model, [Ko.axioms.find(x => x.name === item)!.formula]) });
        else {
            const [tw, x] = item.split(':');
            const In = tw === 'PT' ? phiNew.pt : phiNew.dt, Io = tw === 'PT' ? phiOld.pt : phiOld.dt;
            v.push({ condition: 'c', item, detail: `meaning changed: ${Io.get(x)} vs ${In.get(x)}`, countermodel: keep(a.model, [Io.get(x)!, In.get(x)!]) });
        }
    }
    return { holds: v.length === 0, violations: v, smtCalls: qs.length, timeMs: Date.now() - t0 };
}
