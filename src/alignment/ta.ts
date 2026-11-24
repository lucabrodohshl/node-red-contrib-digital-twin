/**
 * Timed automata (diagonal-free, clock-only) used as PT and DT views.
 */

export type CmpOp = '<' | '<=' | '==' | '>=' | '>';

/** x ~ c, or x - y ~ c when y is set. */
export interface ClockConstraint { x: string; y?: string; op: CmpOp; c: number; }

export interface Location {
    name: string;
    invariant: ClockConstraint[];
    /** Atomic propositions holding in this location. */
    labels: string[];
}

export interface Edge {
    from: string;
    to: string;
    /** Event label; '' or 'tau' denotes an internal step. */
    label: string;
    guard: ClockConstraint[];
    resets: string[];
}

export interface TimedAutomaton {
    name: string;
    clocks: string[];
    locations: Location[];
    edges: Edge[];
    initial: string;
}

/** User-facing JSON description of a timed automaton. */
export interface TASpec {
    name?: string;
    clocks?: string[] | string;
    initial: string;
    locations: Array<string | {
        name: string;
        invariant?: string;
        labels?: string[] | string;
    }>;
    edges: Array<{
        from: string;
        to: string;
        label?: string;
        guard?: string;
        reset?: string[] | string;
    }>;
}

const OPS: CmpOp[] = ['<=', '>=', '==', '<', '>'];

function splitList(v: string[] | string | undefined): string[] {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.map(s => s.trim()).filter(Boolean);
    return v.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

/** Parses e.g. "x <= 5 && y > 2" (also accepts "and", "," and UPPAAL's "="). */
export function parseConstraints(src: string | undefined): ClockConstraint[] {
    if (!src) return [];
    const text = src.trim();
    if (text === '' || text === 'true') return [];
    const out: ClockConstraint[] = [];
    for (let atom of text.split(/&&|\band\b|,/)) {
        atom = atom.trim().replace(/^\(+|\)+$/g, '').trim();
        if (!atom || atom === 'true') continue;
        let op: CmpOp | undefined, idx = -1;
        for (const o of OPS) { idx = atom.indexOf(o); if (idx >= 0) { op = o; break; } }
        if (!op) throw new Error(`Cannot parse clock constraint '${atom}'`);
        let lhs = atom.slice(0, idx).trim(), rhs = atom.slice(idx + op.length).trim();
        // allow "5 >= x"
        if (/^-?\d+$/.test(lhs) && !/^-?\d+$/.test(rhs)) {
            const flip: Record<CmpOp, CmpOp> = { '<': '>', '<=': '>=', '==': '==', '>=': '<=', '>': '<' };
            [lhs, rhs] = [rhs, lhs];
            op = flip[op];
        }
        if (!/^-?\d+$/.test(rhs)) throw new Error(`Constraint '${atom}': right-hand side must be an integer`);
        const c = parseInt(rhs, 10);
        const diff = lhs.split('-').map(s => s.trim());
        if (diff.length === 1) out.push({ x: diff[0], op, c });
        else if (diff.length === 2) out.push({ x: diff[0], y: diff[1], op, c });
        else throw new Error(`Cannot parse clock expression '${lhs}'`);
    }
    return out;
}

export function constraintToString(c: ClockConstraint): string {
    return `${c.x}${c.y ? '-' + c.y : ''}${c.op}${c.c}`;
}

export function isInternalLabel(l: string): boolean {
    return l === '' || l === 'tau' || l === 'τ';
}

export function parseTA(spec: TASpec): TimedAutomaton {
    const clocks = splitList(spec.clocks);
    const locations: Location[] = spec.locations.map(l => {
        if (typeof l === 'string') return { name: l, invariant: [], labels: [l] };
        return {
            name: l.name,
            invariant: parseConstraints(l.invariant),
            labels: l.labels === undefined ? [l.name] : splitList(l.labels),
        };
    });
    const edges: Edge[] = spec.edges.map(e => ({
        from: e.from, to: e.to,
        label: (e.label || '').trim(),
        guard: parseConstraints(e.guard),
        resets: splitList(e.reset),
    }));
    const ta: TimedAutomaton = { name: spec.name || 'TA', clocks, locations, edges, initial: spec.initial };
    validateTA(ta);
    return ta;
}

export function validateTA(ta: TimedAutomaton): void {
    const locs = new Set(ta.locations.map(l => l.name));
    const clocks = new Set(ta.clocks);
    const err = (m: string) => { throw new Error(`[${ta.name}] ${m}`); };
    if (!locs.has(ta.initial)) err(`initial location '${ta.initial}' is not declared`);
    const checkC = (cs: ClockConstraint[], where: string) => {
        for (const c of cs) {
            if (!clocks.has(c.x)) err(`unknown clock '${c.x}' in ${where}`);
            if (c.y !== undefined) err(`diagonal constraint '${constraintToString(c)}' in ${where} is not supported`);
        }
    };
    for (const l of ta.locations) {
        checkC(l.invariant, `invariant of ${l.name}`);
        for (const c of l.invariant)
            if (c.op === '>' || c.op === '>=' || c.op === '==')
                err(`invariant of ${l.name} must be an upper bound, got '${constraintToString(c)}'`);
    }
    for (const e of ta.edges) {
        if (!locs.has(e.from)) err(`edge source '${e.from}' is not declared`);
        if (!locs.has(e.to)) err(`edge target '${e.to}' is not declared`);
        checkC(e.guard, `guard of ${e.from}->${e.to}`);
        for (const r of e.resets) if (!clocks.has(r)) err(`unknown clock '${r}' reset on ${e.from}->${e.to}`);
    }
}

/** Interleaving parallel composition with disjoint clocks (clocks are prefixed). */
export function compose(name: string, parts: TimedAutomaton[]): TimedAutomaton {
    const ren = parts.map((p, k) => {
        const pre = `${p.name || 'c' + k}.`;
        const rc = (c: ClockConstraint): ClockConstraint => ({ ...c, x: pre + c.x, y: c.y ? pre + c.y : undefined });
        return {
            clocks: p.clocks.map(c => pre + c),
            locs: new Map(p.locations.map(l => [l.name, { ...l, invariant: l.invariant.map(rc) }])),
            edges: p.edges.map(e => ({ ...e, guard: e.guard.map(rc), resets: e.resets.map(r => pre + r) })),
            initial: p.initial,
        };
    });
    const clocks = ([] as string[]).concat(...ren.map(r => r.clocks));
    const key = (v: string[]) => v.join('|');
    const start = ren.map(r => r.initial);
    const locations: Location[] = [];
    const edges: Edge[] = [];
    const seen = new Set<string>([key(start)]);
    const queue: string[][] = [start];
    while (queue.length) {
        const cur = queue.shift()!;
        const comps = cur.map((l, k) => ren[k].locs.get(l)!);
        locations.push({
            name: key(cur),
            invariant: ([] as ClockConstraint[]).concat(...comps.map(c => c.invariant)),
            labels: ([] as string[]).concat(...comps.map(c => c.labels)),
        });
        ren.forEach((r, k) => {
            for (const e of r.edges) {
                if (e.from !== cur[k]) continue;
                const nxt = cur.slice(); nxt[k] = e.to;
                edges.push({ from: key(cur), to: key(nxt), label: e.label, guard: e.guard, resets: e.resets });
                if (!seen.has(key(nxt))) { seen.add(key(nxt)); queue.push(nxt); }
            }
        });
    }
    return { name, clocks, locations, edges, initial: key(start) };
}

/** Collects, per clock, the largest constant it is compared with. */
export function maxConstants(ta: TimedAutomaton): Map<string, number> {
    const m = new Map<string, number>(ta.clocks.map(c => [c, 0]));
    const upd = (cs: ClockConstraint[]) => cs.forEach(c => m.set(c.x, Math.max(m.get(c.x) || 0, Math.abs(c.c))));
    ta.locations.forEach(l => upd(l.invariant));
    ta.edges.forEach(e => upd(e.guard));
    return m;
}

function xmlDecode(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Imports a single template of an UPPAAL XML model (clocks only). Location
 * names become atomic propositions; synchronisations become event labels.
 */
export function parseUppaalXml(xml: string, templateName?: string): TimedAutomaton {
    const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const globalDecl = stripComments(xmlDecode((xml.match(/<nta>\s*<declaration>([\s\S]*?)<\/declaration>/) || [])[1] || ''));
    const templates = xml.match(/<template>[\s\S]*?<\/template>/g) || [];
    if (!templates.length) throw new Error('UPPAAL model has no template');
    const tpl = templateName
        ? templates.find(t => (t.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1]?.trim() === templateName)
        : templates[0];
    if (!tpl) throw new Error(`template '${templateName}' not found`);
    const localDecl = stripComments(xmlDecode((tpl.match(/<declaration>([\s\S]*?)<\/declaration>/) || [])[1] || ''));
    const clocks: string[] = [];
    for (const decl of [globalDecl, localDecl]) {
        const re = /\bclock\s+([^;]+);/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(decl))) clocks.push(...mm[1].split(',').map(s => s.trim()).filter(Boolean));
    }
    const name = ((tpl.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || 'TA').trim();
    const idToName = new Map<string, string>();
    const locations: Location[] = [];
    const locRe = /<location\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/location>|<location\s+id="([^"]+)"[^>]*\/>/g;
    let lm: RegExpExecArray | null;
    while ((lm = locRe.exec(tpl))) {
        const id = lm[1] || lm[3];
        const body = lm[2] || '';
        const nm = ((body.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || id).trim();
        const inv = xmlDecode((body.match(/<label\s+kind="invariant"[^>]*>([\s\S]*?)<\/label>/) || [])[1] || '');
        idToName.set(id, nm);
        locations.push({ name: nm, invariant: parseConstraints(inv), labels: [nm] });
    }
    const initRef = (tpl.match(/<init\s+ref="([^"]+)"/) || [])[1];
    if (!initRef) throw new Error('UPPAAL template has no initial location');
    const edges: Edge[] = [];
    const trRe = /<transition[^>]*>([\s\S]*?)<\/transition>/g;
    let tm: RegExpExecArray | null;
    while ((tm = trRe.exec(tpl))) {
        const body = tm[1];
        const src = (body.match(/<source\s+ref="([^"]+)"/) || [])[1];
        const dst = (body.match(/<target\s+ref="([^"]+)"/) || [])[1];
        const lab = (k: string) => xmlDecode((body.match(new RegExp(`<label\\s+kind="${k}"[^>]*>([\\s\\S]*?)<\\/label>`)) || [])[1] || '').trim();
        const assign = lab('assignment');
        const resets = assign ? assign.split(',').map(a => a.trim()).filter(Boolean).map(a => {
            const [lhs, rhs] = a.split(/:?=/).map(s => s.trim());
            if (rhs !== '0' || !clocks.includes(lhs)) throw new Error(`unsupported assignment '${a}' (only clock resets to 0)`);
            return lhs;
        }) : [];
        edges.push({
            from: idToName.get(src!)!, to: idToName.get(dst!)!,
            label: lab('synchronisation'), guard: parseConstraints(lab('guard')), resets,
        });
    }
    const ta: TimedAutomaton = { name, clocks, locations, edges, initial: idToName.get(initRef)! };
    validateTA(ta);
    return ta;
}
