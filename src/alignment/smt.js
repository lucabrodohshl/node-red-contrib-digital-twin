"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSmtBatch = exports.parenDepth = exports.showSExpr = exports.parseSExprs = exports.tokenize = exports.resolveZ3Path = exports.SmtError = void 0;
/**
 * Minimal SMT back-end: batches SMT-LIB2 queries into a single z3 process.
 */
const child_process_1 = require("child_process");
class SmtError extends Error {
}
exports.SmtError = SmtError;
function resolveZ3Path(explicit) {
    return explicit || process.env.Z3_PATH || 'z3';
}
exports.resolveZ3Path = resolveZ3Path;
function tokenize(src) {
    const toks = [];
    const re = /\s*(\(|\)|\|[^|]*\||"[^"]*"|[^\s()]+)/g;
    let m;
    while ((m = re.exec(src)))
        toks.push(m[1]);
    return toks;
}
exports.tokenize = tokenize;
function parseSExprs(src) {
    const toks = tokenize(src);
    let pos = 0;
    const read = () => {
        const t = toks[pos++];
        if (t === '(') {
            const list = [];
            while (pos < toks.length && toks[pos] !== ')')
                list.push(read());
            pos++;
            return list;
        }
        return t;
    };
    const out = [];
    while (pos < toks.length)
        out.push(read());
    return out;
}
exports.parseSExprs = parseSExprs;
function showSExpr(e) {
    return typeof e === 'string' ? e : '(' + e.map(showSExpr).join(' ') + ')';
}
exports.showSExpr = showSExpr;
/** Checks that parentheses balance (used to split multi-line statements). */
function parenDepth(s) {
    let d = 0;
    for (const ch of s) {
        if (ch === '(')
            d++;
        else if (ch === ')')
            d--;
    }
    return d;
}
exports.parenDepth = parenDepth;
function renderValue(e) {
    if (typeof e === 'string') {
        const n = Number(e);
        return isNaN(n) ? e : String(n);
    }
    if (e[0] === '-' && e.length === 2) {
        const v = renderValue(e[1]);
        return isNaN(Number(v)) ? `-${v}` : String(-Number(v));
    }
    if (e[0] === '/' && e.length === 3) {
        const a = Number(renderValue(e[1])), b = Number(renderValue(e[2]));
        if (!isNaN(a) && !isNaN(b) && b !== 0)
            return String(Math.round((a / b) * 1e6) / 1e6);
    }
    return showSExpr(e);
}
function parseModel(text) {
    const model = {};
    const exprs = parseSExprs(text);
    const visit = (e) => {
        if (!Array.isArray(e))
            return;
        if (e[0] === 'define-fun' && e.length === 5) {
            const name = e[1], args = e[2];
            if (Array.isArray(args) && args.length === 0)
                model[name] = renderValue(e[4]);
            else
                model[name] = showSExpr(e[4]).slice(0, 120);
            return;
        }
        e.forEach(visit);
    };
    exprs.forEach(visit);
    return model;
}
/** Runs all queries in one z3 invocation; each query lives in its own push/pop scope. */
function runSmtBatch(preamble, base, queries, z3Path) {
    const result = new Map();
    if (queries.length === 0)
        return result;
    const lines = ['(set-option :produce-models true)', preamble];
    for (const b of base)
        lines.push(`(assert ${b})`);
    lines.push('(echo "@@BASE")');
    queries.forEach((q, k) => {
        lines.push(`(echo "@@Q ${k}")`, '(push 1)');
        for (const a of q.assertions)
            lines.push(`(assert ${a})`);
        lines.push('(check-sat)');
        if (q.wantModel)
            lines.push('(echo "@@M")', '(get-model)');
        lines.push('(pop 1)');
    });
    const script = lines.join('\n') + '\n';
    const out = (0, child_process_1.spawnSync)(resolveZ3Path(z3Path), ['-in', '-smt2'], { input: script, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (out.error)
        throw new SmtError(`cannot run z3 (${resolveZ3Path(z3Path)}): ${out.error.message}`);
    const stdout = out.stdout || '';
    const [head, rest = ''] = stdout.split('@@BASE');
    const headErr = head.match(/\(error "([^"]*)"\)/);
    if (headErr)
        throw new SmtError(`ontology does not parse: ${headErr[1]}`);
    const chunks = rest.split(/@@Q (\d+)\n/);
    for (let k = 1; k < chunks.length; k += 2) {
        const q = queries[parseInt(chunks[k], 10)];
        const body = chunks[k + 1];
        const [statusPart, modelPart] = body.split('@@M');
        const err = statusPart.match(/\(error "([^"]*)"\)/);
        if (err)
            throw new SmtError(`formula of '${q.id}' does not parse: ${err[1]}`);
        const st = (statusPart.match(/\b(unsat|sat|unknown)\b/) || [])[1];
        if (!st)
            throw new SmtError(`no answer from z3 for '${q.id}'`);
        const ans = { status: st };
        if (st === 'sat' && modelPart)
            ans.model = parseModel(modelPart);
        result.set(q.id, ans);
    }
    return result;
}
exports.runSmtBatch = runSmtBatch;
//# sourceMappingURL=smt.js.map