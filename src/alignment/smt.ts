/**
 * Minimal SMT back-end: batches SMT-LIB2 queries into a single z3 process.
 */
import { spawnSync } from 'child_process';

export type SmtStatus = 'sat' | 'unsat' | 'unknown';

export interface SmtQuery {
    id: string;
    /** SMT-LIB2 Boolean terms asserted in an isolated scope. */
    assertions: string[];
    wantModel?: boolean;
}

export interface SmtAnswer { status: SmtStatus; model?: Record<string, string>; }

export class SmtError extends Error {}

export function resolveZ3Path(explicit?: string): string {
    return explicit || process.env.Z3_PATH || 'z3';
}

// ---------------------------------------------------------------- s-exprs --
export type SExpr = string | SExpr[];

export function tokenize(src: string): string[] {
    const toks: string[] = [];
    const re = /\s*(\(|\)|\|[^|]*\||"[^"]*"|[^\s()]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) toks.push(m[1]);
    return toks;
}

export function parseSExprs(src: string): SExpr[] {
    const toks = tokenize(src);
    let pos = 0;
    const read = (): SExpr => {
        const t = toks[pos++];
        if (t === '(') {
            const list: SExpr[] = [];
            while (pos < toks.length && toks[pos] !== ')') list.push(read());
            pos++;
            return list;
        }
        return t;
    };
    const out: SExpr[] = [];
    while (pos < toks.length) out.push(read());
    return out;
}

export function showSExpr(e: SExpr): string {
    return typeof e === 'string' ? e : '(' + e.map(showSExpr).join(' ') + ')';
}

/** Checks that parentheses balance (used to split multi-line statements). */
export function parenDepth(s: string): number {
    let d = 0;
    for (const ch of s) { if (ch === '(') d++; else if (ch === ')') d--; }
    return d;
}

function renderValue(e: SExpr): string {
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
        if (!isNaN(a) && !isNaN(b) && b !== 0) return String(Math.round((a / b) * 1e6) / 1e6);
    }
    return showSExpr(e);
}

function parseModel(text: string): Record<string, string> {
    const model: Record<string, string> = {};
    const exprs = parseSExprs(text);
    const visit = (e: SExpr) => {
        if (!Array.isArray(e)) return;
        if (e[0] === 'define-fun' && e.length === 5) {
            const name = e[1] as string, args = e[2] as SExpr[];
            if (Array.isArray(args) && args.length === 0) model[name] = renderValue(e[4]);
            else model[name] = showSExpr(e[4]).slice(0, 120);
            return;
        }
        e.forEach(visit);
    };
    exprs.forEach(visit);
    return model;
}

/** Runs all queries in one z3 invocation; each query lives in its own push/pop scope. */
export function runSmtBatch(preamble: string, base: string[], queries: SmtQuery[], z3Path?: string): Map<string, SmtAnswer> {
    const result = new Map<string, SmtAnswer>();
    if (queries.length === 0) return result;
    const lines: string[] = ['(set-option :produce-models true)', preamble];
    for (const b of base) lines.push(`(assert ${b})`);
    lines.push('(echo "@@BASE")');
    queries.forEach((q, k) => {
        lines.push(`(echo "@@Q ${k}")`, '(push 1)');
        for (const a of q.assertions) lines.push(`(assert ${a})`);
        lines.push('(check-sat)');
        if (q.wantModel) lines.push('(echo "@@M")', '(get-model)');
        lines.push('(pop 1)');
    });
    const script = lines.join('\n') + '\n';
    const out = spawnSync(resolveZ3Path(z3Path), ['-in', '-smt2'], { input: script, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (out.error) throw new SmtError(`cannot run z3 (${resolveZ3Path(z3Path)}): ${out.error.message}`);
    const stdout = out.stdout || '';
    const [head, rest = ''] = stdout.split('@@BASE');
    const headErr = head.match(/\(error "([^"]*)"\)/);
    if (headErr) throw new SmtError(`ontology does not parse: ${headErr[1]}`);
    const chunks = rest.split(/@@Q (\d+)\n/);
    for (let k = 1; k < chunks.length; k += 2) {
        const q = queries[parseInt(chunks[k], 10)];
        const body = chunks[k + 1];
        const [statusPart, modelPart] = body.split('@@M');
        const err = statusPart.match(/\(error "([^"]*)"\)/);
        if (err) throw new SmtError(`formula of '${q.id}' does not parse: ${err[1]}`);
        const st = (statusPart.match(/\b(unsat|sat|unknown)\b/) || [])[1] as SmtStatus | undefined;
        if (!st) throw new SmtError(`no answer from z3 for '${q.id}'`);
        const ans: SmtAnswer = { status: st };
        if (st === 'sat' && modelPart) ans.model = parseModel(modelPart);
        result.set(q.id, ans);
    }
    return result;
}
