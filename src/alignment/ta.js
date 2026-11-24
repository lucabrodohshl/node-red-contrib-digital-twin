"use strict";
/**
 * Timed automata (diagonal-free, clock-only) used as PT and DT views.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseUppaalXml = exports.maxConstants = exports.compose = exports.validateTA = exports.parseTA = exports.isInternalLabel = exports.constraintToString = exports.parseConstraints = void 0;
const OPS = ['<=', '>=', '==', '<', '>'];
function splitList(v) {
    if (v === undefined)
        return [];
    if (Array.isArray(v))
        return v.map(s => s.trim()).filter(Boolean);
    return v.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}
/** Parses e.g. "x <= 5 && y > 2" (also accepts "and", "," and UPPAAL's "="). */
function parseConstraints(src) {
    if (!src)
        return [];
    const text = src.trim();
    if (text === '' || text === 'true')
        return [];
    const out = [];
    for (let atom of text.split(/&&|\band\b|,/)) {
        atom = atom.trim().replace(/^\(+|\)+$/g, '').trim();
        if (!atom || atom === 'true')
            continue;
        let op, idx = -1;
        for (const o of OPS) {
            idx = atom.indexOf(o);
            if (idx >= 0) {
                op = o;
                break;
            }
        }
        if (!op)
            throw new Error(`Cannot parse clock constraint '${atom}'`);
        let lhs = atom.slice(0, idx).trim(), rhs = atom.slice(idx + op.length).trim();
        // allow "5 >= x"
        if (/^-?\d+$/.test(lhs) && !/^-?\d+$/.test(rhs)) {
            const flip = { '<': '>', '<=': '>=', '==': '==', '>=': '<=', '>': '<' };
            [lhs, rhs] = [rhs, lhs];
            op = flip[op];
        }
        if (!/^-?\d+$/.test(rhs))
            throw new Error(`Constraint '${atom}': right-hand side must be an integer`);
        const c = parseInt(rhs, 10);
        const diff = lhs.split('-').map(s => s.trim());
        if (diff.length === 1)
            out.push({ x: diff[0], op, c });
        else if (diff.length === 2)
            out.push({ x: diff[0], y: diff[1], op, c });
        else
            throw new Error(`Cannot parse clock expression '${lhs}'`);
    }
    return out;
}
exports.parseConstraints = parseConstraints;
function constraintToString(c) {
    return `${c.x}${c.y ? '-' + c.y : ''}${c.op}${c.c}`;
}
exports.constraintToString = constraintToString;
function isInternalLabel(l) {
    return l === '' || l === 'tau' || l === 'τ';
}
exports.isInternalLabel = isInternalLabel;
function parseTA(spec) {
    const clocks = splitList(spec.clocks);
    const locations = spec.locations.map(l => {
        if (typeof l === 'string')
            return { name: l, invariant: [], labels: [l] };
        return {
            name: l.name,
            invariant: parseConstraints(l.invariant),
            labels: l.labels === undefined ? [l.name] : splitList(l.labels),
        };
    });
    const edges = spec.edges.map(e => ({
        from: e.from, to: e.to,
        label: (e.label || '').trim(),
        guard: parseConstraints(e.guard),
        resets: splitList(e.reset),
    }));
    const ta = { name: spec.name || 'TA', clocks, locations, edges, initial: spec.initial };
    validateTA(ta);
    return ta;
}
exports.parseTA = parseTA;
function validateTA(ta) {
    const locs = new Set(ta.locations.map(l => l.name));
    const clocks = new Set(ta.clocks);
    const err = (m) => { throw new Error(`[${ta.name}] ${m}`); };
    if (!locs.has(ta.initial))
        err(`initial location '${ta.initial}' is not declared`);
    const checkC = (cs, where) => {
        for (const c of cs) {
            if (!clocks.has(c.x))
                err(`unknown clock '${c.x}' in ${where}`);
            if (c.y !== undefined)
                err(`diagonal constraint '${constraintToString(c)}' in ${where} is not supported`);
        }
    };
    for (const l of ta.locations) {
        checkC(l.invariant, `invariant of ${l.name}`);
        for (const c of l.invariant)
            if (c.op === '>' || c.op === '>=' || c.op === '==')
                err(`invariant of ${l.name} must be an upper bound, got '${constraintToString(c)}'`);
    }
    for (const e of ta.edges) {
        if (!locs.has(e.from))
            err(`edge source '${e.from}' is not declared`);
        if (!locs.has(e.to))
            err(`edge target '${e.to}' is not declared`);
        checkC(e.guard, `guard of ${e.from}->${e.to}`);
        for (const r of e.resets)
            if (!clocks.has(r))
                err(`unknown clock '${r}' reset on ${e.from}->${e.to}`);
    }
}
exports.validateTA = validateTA;
/** Interleaving parallel composition with disjoint clocks (clocks are prefixed). */
function compose(name, parts) {
    const ren = parts.map((p, k) => {
        const pre = `${p.name || 'c' + k}.`;
        const rc = (c) => ({ ...c, x: pre + c.x, y: c.y ? pre + c.y : undefined });
        return {
            clocks: p.clocks.map(c => pre + c),
            locs: new Map(p.locations.map(l => [l.name, { ...l, invariant: l.invariant.map(rc) }])),
            edges: p.edges.map(e => ({ ...e, guard: e.guard.map(rc), resets: e.resets.map(r => pre + r) })),
            initial: p.initial,
        };
    });
    const clocks = [].concat(...ren.map(r => r.clocks));
    const key = (v) => v.join('|');
    const start = ren.map(r => r.initial);
    const locations = [];
    const edges = [];
    const seen = new Set([key(start)]);
    const queue = [start];
    while (queue.length) {
        const cur = queue.shift();
        const comps = cur.map((l, k) => ren[k].locs.get(l));
        locations.push({
            name: key(cur),
            invariant: [].concat(...comps.map(c => c.invariant)),
            labels: [].concat(...comps.map(c => c.labels)),
        });
        ren.forEach((r, k) => {
            for (const e of r.edges) {
                if (e.from !== cur[k])
                    continue;
                const nxt = cur.slice();
                nxt[k] = e.to;
                edges.push({ from: key(cur), to: key(nxt), label: e.label, guard: e.guard, resets: e.resets });
                if (!seen.has(key(nxt))) {
                    seen.add(key(nxt));
                    queue.push(nxt);
                }
            }
        });
    }
    return { name, clocks, locations, edges, initial: key(start) };
}
exports.compose = compose;
/** Collects, per clock, the largest constant it is compared with. */
function maxConstants(ta) {
    const m = new Map(ta.clocks.map(c => [c, 0]));
    const upd = (cs) => cs.forEach(c => m.set(c.x, Math.max(m.get(c.x) || 0, Math.abs(c.c))));
    ta.locations.forEach(l => upd(l.invariant));
    ta.edges.forEach(e => upd(e.guard));
    return m;
}
exports.maxConstants = maxConstants;
function xmlDecode(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
/**
 * Imports a single template of an UPPAAL XML model (clocks only). Location
 * names become atomic propositions; synchronisations become event labels.
 */
function parseUppaalXml(xml, templateName) {
    const stripComments = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const globalDecl = stripComments(xmlDecode((xml.match(/<nta>\s*<declaration>([\s\S]*?)<\/declaration>/) || [])[1] || ''));
    const templates = xml.match(/<template>[\s\S]*?<\/template>/g) || [];
    if (!templates.length)
        throw new Error('UPPAAL model has no template');
    const tpl = templateName
        ? templates.find(t => { var _a; return ((_a = (t.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1]) === null || _a === void 0 ? void 0 : _a.trim()) === templateName; })
        : templates[0];
    if (!tpl)
        throw new Error(`template '${templateName}' not found`);
    const localDecl = stripComments(xmlDecode((tpl.match(/<declaration>([\s\S]*?)<\/declaration>/) || [])[1] || ''));
    const clocks = [];
    for (const decl of [globalDecl, localDecl]) {
        const re = /\bclock\s+([^;]+);/g;
        let mm;
        while ((mm = re.exec(decl)))
            clocks.push(...mm[1].split(',').map(s => s.trim()).filter(Boolean));
    }
    const name = ((tpl.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || 'TA').trim();
    const idToName = new Map();
    const locations = [];
    const locRe = /<location\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/location>|<location\s+id="([^"]+)"[^>]*\/>/g;
    let lm;
    while ((lm = locRe.exec(tpl))) {
        const id = lm[1] || lm[3];
        const body = lm[2] || '';
        const nm = ((body.match(/<name[^>]*>([\s\S]*?)<\/name>/) || [])[1] || id).trim();
        const inv = xmlDecode((body.match(/<label\s+kind="invariant"[^>]*>([\s\S]*?)<\/label>/) || [])[1] || '');
        idToName.set(id, nm);
        locations.push({ name: nm, invariant: parseConstraints(inv), labels: [nm] });
    }
    const initRef = (tpl.match(/<init\s+ref="([^"]+)"/) || [])[1];
    if (!initRef)
        throw new Error('UPPAAL template has no initial location');
    const edges = [];
    const trRe = /<transition[^>]*>([\s\S]*?)<\/transition>/g;
    let tm;
    while ((tm = trRe.exec(tpl))) {
        const body = tm[1];
        const src = (body.match(/<source\s+ref="([^"]+)"/) || [])[1];
        const dst = (body.match(/<target\s+ref="([^"]+)"/) || [])[1];
        const lab = (k) => xmlDecode((body.match(new RegExp(`<label\\s+kind="${k}"[^>]*>([\\s\\S]*?)<\\/label>`)) || [])[1] || '').trim();
        const assign = lab('assignment');
        const resets = assign ? assign.split(',').map(a => a.trim()).filter(Boolean).map(a => {
            const [lhs, rhs] = a.split(/:?=/).map(s => s.trim());
            if (rhs !== '0' || !clocks.includes(lhs))
                throw new Error(`unsupported assignment '${a}' (only clock resets to 0)`);
            return lhs;
        }) : [];
        edges.push({
            from: idToName.get(src), to: idToName.get(dst),
            label: lab('synchronisation'), guard: parseConstraints(lab('guard')), resets,
        });
    }
    const ta = { name, clocks, locations, edges, initial: idToName.get(initRef) };
    validateTA(ta);
    return ta;
}
exports.parseUppaalXml = parseUppaalXml;
//# sourceMappingURL=ta.js.map