"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloneOntology = exports.substitute = exports.isTau = exports.parseInterpretation = exports.smtPreamble = exports.parseOntology = void 0;
/**
 * Ontologies K = (S, F, R, Delta) and interpretations I : AP u Sigma -> L(K) u {tau}.
 *
 * Text format:
 *   sort Energy            ; user sorts are interpreted over Real
 *   sort Count : Int       ; ... unless a base sort is given
 *   fun soc : Energy
 *   fun cons : Cell -> Energy
 *   rel armed :
 *   axiom reserve : (= soc_rtb 25)
 * Interpretations:  label : <SMT-LIB2 Boolean term>   or   label : tau
 */
const smt_1 = require("./smt");
const BUILTIN = new Set(['Real', 'Int', 'Bool']);
/** Splits text into logical statements; a statement may span lines until parentheses balance. */
function statements(text) {
    const out = [];
    let cur = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/;.*$/, '').trim();
        if (!line)
            continue;
        cur = cur ? cur + ' ' + line : line;
        if ((0, smt_1.parenDepth)(cur) <= 0) {
            out.push(cur);
            cur = '';
        }
    }
    if (cur.trim())
        throw new Error(`unbalanced parentheses near: ${cur.slice(0, 60)}`);
    return out;
}
function parseOntology(text, name = 'K') {
    const ont = { name, sorts: new Map(), functions: [], axioms: [] };
    const mapSort = (s) => (BUILTIN.has(s) ? s : (ont.sorts.get(s) || (() => { throw new Error(`unknown sort '${s}'`); })()));
    for (const st of statements(text)) {
        const m = st.match(/^(sort|fun|rel|axiom)\s+([^\s:]+)\s*(?::\s*(.*))?$/);
        if (!m)
            throw new Error(`cannot parse ontology statement: ${st}`);
        const [, kw, id, body = ''] = m;
        if (kw === 'sort') {
            const base = body.trim() || 'Real';
            if (!BUILTIN.has(base))
                throw new Error(`sort ${id}: base must be Real, Int or Bool`);
            ont.sorts.set(id, base);
        }
        else if (kw === 'fun') {
            const [lhs, rhs] = body.includes('->') ? body.split('->') : ['', body];
            ont.functions.push({ name: id, args: lhs.trim().split(/\s+/).filter(Boolean).map(mapSort), ret: mapSort(rhs.trim() || 'Real') });
        }
        else if (kw === 'rel') {
            ont.functions.push({ name: id, args: body.trim().split(/\s+/).filter(Boolean).map(mapSort), ret: 'Bool' });
        }
        else {
            if (!body.trim())
                throw new Error(`axiom ${id} has no formula`);
            ont.axioms.push({ name: id, formula: body.trim() });
        }
    }
    return ont;
}
exports.parseOntology = parseOntology;
function smtPreamble(ont) {
    return ont.functions.map(f => `(declare-fun ${f.name} (${f.args.join(' ')}) ${f.ret})`).join('\n');
}
exports.smtPreamble = smtPreamble;
function parseInterpretation(text) {
    const I = new Map();
    for (const st of statements(text)) {
        // label may contain '!' or '?' (UPPAAL synchronisations); split on the first ' : ' / ':'
        const m = st.match(/^([^\s:]+)\s*:\s*([\s\S]+)$/);
        if (!m && !st.includes(':') && !st.includes('('))
            continue; // stray prose line (missing ';')
        if (!m)
            throw new Error(`cannot parse interpretation entry: ${st}`);
        const f = m[2].trim();
        I.set(m[1], f === 'τ' ? 'tau' : f);
    }
    return I;
}
exports.parseInterpretation = parseInterpretation;
function isTau(f) { return f === undefined || f === 'tau'; }
exports.isTau = isTau;
/** Replaces symbols by terms (used to bind Node-RED property names to ontology terms). */
function substitute(formula, bindings) {
    if (bindings.size === 0)
        return formula;
    return (0, smt_1.tokenize)(formula).map(t => { var _a; return (_a = bindings.get(t)) !== null && _a !== void 0 ? _a : t; }).join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}
exports.substitute = substitute;
function cloneOntology(o) {
    return { name: o.name, sorts: new Map(o.sorts), functions: o.functions.map(f => ({ ...f, args: f.args.slice() })), axioms: o.axioms.map(a => ({ ...a })) };
}
exports.cloneOntology = cloneOntology;
//# sourceMappingURL=ontology.js.map