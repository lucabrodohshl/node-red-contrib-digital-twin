/**
 * Difference Bound Matrices (DBMs) for zone-based analysis of timed automata.
 *
 * Index 0 is the reference clock (constant 0); indices 1..n are real clocks.
 * Entry D[i][j] bounds the difference x_i - x_j.  Bounds are encoded as
 * integers: (c, <=) -> 2c+1 and (c, <) -> 2c; INF encodes "no bound".
 */

export const INF = 0x3fffffff;

export const le = (c: number): number => 2 * c + 1;
export const lt = (c: number): number => 2 * c;
export const LE_ZERO = 1;

export function boundValue(b: number): number { return b >> 1; }
export function isStrict(b: number): boolean { return (b & 1) === 0; }

export function addBounds(a: number, b: number): number {
    if (a === INF || b === INF) return INF;
    return 2 * ((a >> 1) + (b >> 1)) + ((a & 1) & (b & 1));
}

/** Negation of x_i - x_j ~ c is x_j - x_i ~' -c with flipped strictness. */
export function negateBound(b: number): number { return 1 - b; }

export function boundToString(b: number): string {
    if (b === INF) return '<inf';
    return (isStrict(b) ? '<' : '<=') + boundValue(b);
}

/** An atomic difference constraint x_i - x_j ~ bound (indices into a DBM). */
export interface DiffConstraint { i: number; j: number; bound: number; }

export class DBM {
    readonly dim: number;
    readonly m: Int32Array;

    private constructor(dim: number, m?: Int32Array) {
        this.dim = dim;
        this.m = m ? m : new Int32Array(dim * dim);
    }

    /** Zone in which every clock equals zero. */
    static zero(dim: number): DBM {
        const d = new DBM(dim);
        d.m.fill(LE_ZERO);
        return d;
    }

    /** Zone containing every non-negative valuation. */
    static universe(dim: number): DBM {
        const d = new DBM(dim);
        d.m.fill(INF);
        for (let i = 0; i < dim; i++) {
            d.m[i * dim + i] = LE_ZERO;
            d.m[i] = LE_ZERO; // 0 - x_i <= 0
        }
        return d;
    }

    get(i: number, j: number): number { return this.m[i * this.dim + j]; }
    private set(i: number, j: number, b: number): void { this.m[i * this.dim + j] = b; }

    copy(): DBM { return new DBM(this.dim, new Int32Array(this.m)); }

    /** Floyd-Warshall canonicalisation; returns false iff the zone is empty. */
    close(): boolean {
        const n = this.dim, m = this.m;
        for (let k = 0; k < n; k++) {
            for (let i = 0; i < n; i++) {
                const ik = m[i * n + k];
                if (ik === INF) continue;
                for (let j = 0; j < n; j++) {
                    const kj = m[k * n + j];
                    if (kj === INF) continue;
                    const s = addBounds(ik, kj);
                    if (s < m[i * n + j]) m[i * n + j] = s;
                }
            }
            if (m[k * n + k] < LE_ZERO) return false;
        }
        for (let i = 0; i < n; i++) if (m[i * n + i] < LE_ZERO) return false;
        return true;
    }

    isEmpty(): boolean {
        for (let i = 0; i < this.dim; i++) if (this.get(i, i) < LE_ZERO) return true;
        return false;
    }

    /** Tighten x_i - x_j by b (in place, keeps canonical form). Returns false if empty. */
    constrain(i: number, j: number, b: number): boolean {
        const n = this.dim, m = this.m;
        if (b >= m[i * n + j]) return true;
        if (addBounds(m[j * n + i], b) < LE_ZERO) {
            m[i * n + i] = lt(0) - 2; // mark empty
            return false;
        }
        m[i * n + j] = b;
        for (let k = 0; k < n; k++) {
            const ki = m[k * n + i];
            if (ki === INF) continue;
            const kib = addBounds(ki, b);
            for (let l = 0; l < n; l++) {
                const jl = m[j * n + l];
                if (jl === INF) continue;
                const s = addBounds(kib, jl);
                if (s < m[k * n + l]) m[k * n + l] = s;
            }
        }
        for (let k = 0; k < n; k++) if (m[k * n + k] < LE_ZERO) return false;
        return true;
    }

    /** Applies a list of constraints; returns null when the result is empty. */
    and(cs: DiffConstraint[]): DBM | null {
        const r = this.copy();
        for (const c of cs) if (!r.constrain(c.i, c.j, c.bound)) return null;
        return r;
    }

    intersect(o: DBM): DBM | null {
        const r = this.copy();
        for (let i = 0; i < this.dim; i++)
            for (let j = 0; j < this.dim; j++)
                if (i !== j && o.get(i, j) < r.get(i, j))
                    if (!r.constrain(i, j, o.get(i, j))) return null;
        return r;
    }

    /** Delay closure (time successors). */
    up(): DBM {
        const r = this.copy();
        for (let i = 1; i < this.dim; i++) r.set(i, 0, INF);
        return r;
    }

    reset(x: number): DBM {
        const r = this.copy();
        for (let j = 0; j < this.dim; j++) {
            r.set(x, j, r.get(0, j));
            r.set(j, x, r.get(j, 0));
        }
        r.set(x, x, LE_ZERO);
        return r;
    }

    /** Removes every constraint on clock x (existential projection). */
    free(x: number): DBM {
        const r = this.copy();
        for (let j = 0; j < this.dim; j++) {
            if (j === x) continue;
            r.set(x, j, INF);
            r.set(j, x, r.get(j, 0));
        }
        r.set(0, x, LE_ZERO);
        return r;
    }

    /** Classic k-extrapolation (Extra_M) for diagonal-free automata. */
    extrapolate(maxConst: number[]): DBM {
        const r = this.copy();
        const n = this.dim;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const b = r.get(i, j);
                if (i > 0 && b !== INF && b > le(maxConst[i])) r.set(i, j, INF);
                else if (j > 0 && b < lt(-maxConst[j])) r.set(i, j, lt(-maxConst[j]));
            }
        }
        r.close();
        return r;
    }

    includes(o: DBM): boolean {
        for (let k = 0; k < this.m.length; k++) if (o.m[k] > this.m[k]) return false;
        return true;
    }

    /** True iff the zone satisfies x_i - x_j ~ b everywhere. */
    satisfies(c: DiffConstraint): boolean { return this.get(c.i, c.j) <= c.bound; }

    key(): string { return Array.prototype.join.call(this.m, ','); }

    /**
     * Set difference this \ o as a list of pairwise-disjoint DBMs.
     * Both operands must be canonical and non-empty.
     */
    subtract(o: DBM): DBM[] {
        const out: DBM[] = [];
        let c: DBM = this.copy();
        for (let i = 0; i < this.dim; i++) {
            for (let j = 0; j < this.dim; j++) {
                if (i === j) continue;
                const b = o.get(i, j);
                if (b >= c.get(i, j)) continue;
                const piece = c.copy();
                if (piece.constrain(j, i, negateBound(b))) out.push(piece);
                if (!c.constrain(i, j, b)) return out;
            }
        }
        return out;
    }

    /** A concrete valuation inside the zone (index 0 omitted). */
    sample(): number[] {
        const n = this.dim;
        const v = new Float64Array(n * n), s = new Uint8Array(n * n);
        for (let k = 0; k < n * n; k++) {
            const b = this.m[k];
            v[k] = b === INF ? Infinity : boundValue(b);
            s[k] = b === INF ? 0 : (isStrict(b) ? 1 : 0);
        }
        const closeF = () => {
            for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
                const a = v[i * n + k] + v[k * n + j];
                const st = (s[i * n + k] | s[k * n + j]);
                if (a < v[i * n + j] || (a === v[i * n + j] && st && !s[i * n + j])) {
                    v[i * n + j] = a; s[i * n + j] = st;
                }
            }
        };
        const val: number[] = [];
        for (let i = 1; i < n; i++) {
            const lo = -v[0 * n + i], loStrict = s[0 * n + i] === 1;
            const hi = v[i * n + 0];
            let x: number;
            if (!loStrict) x = lo;
            else if (hi === Infinity) x = lo + 0.5;
            else x = (lo + hi) / 2;
            val.push(x);
            v[i * n] = x; s[i * n] = 0;
            v[i] = -x; s[i] = 0;
            closeF();
        }
        return val;
    }

    toString(names?: string[]): string {
        const nm = (i: number) => (i === 0 ? '0' : names ? names[i] : 'x' + i);
        const parts: string[] = [];
        for (let i = 1; i < this.dim; i++) {
            const lo = this.get(0, i), hi = this.get(i, 0);
            const loS = `${isStrict(lo) ? '>' : '>='}${-boundValue(lo)}`;
            parts.push(hi === INF ? `${nm(i)}${loS}` : `${nm(i)}${loS}&${nm(i)}${boundToString(hi)}`);
        }
        return parts.join(', ');
    }
}

/** Is `zone` covered by the union of `cover`? Returns an uncovered piece if not. */
export function uncoveredPart(zone: DBM, cover: DBM[]): DBM | null {
    let rest: DBM[] = [zone];
    for (const c of cover) {
        const next: DBM[] = [];
        for (const r of rest) {
            const inter = r.intersect(c);
            if (!inter) { next.push(r); continue; }
            for (const p of r.subtract(c)) next.push(p);
        }
        rest = next;
        if (rest.length === 0) return null;
    }
    return rest.length ? rest[0] : null;
}
