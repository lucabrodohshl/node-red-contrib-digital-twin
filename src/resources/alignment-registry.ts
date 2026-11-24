import { EventEmitter } from 'events';

/** Alignment level established for an asset: strong, weak or none (see docs/semantic-alignment.md). */
export type AlignmentLevel = 'strong' | 'weak' | 'none';

export interface AlignmentVerdict {
    level: AlignmentLevel;
    asset: string;
    ptView: string;
    phiVersion: string;
    checkedAt: string;
    reusedByRefinement: boolean;
    witness?: string;
}

const verdicts = new Map<string, AlignmentVerdict>();
const emitter = new EventEmitter();

/** Shared between dt-alignment (writer) and dt-align-gate (reader). */
export namespace AlignmentRegistry {
    export function set(alignmentNodeId: string, v: AlignmentVerdict): void {
        verdicts.set(alignmentNodeId, v);
        emitter.emit('change', alignmentNodeId, v);
    }
    export function get(alignmentNodeId: string): AlignmentVerdict | undefined { return verdicts.get(alignmentNodeId); }
    export function clear(alignmentNodeId: string): void { verdicts.delete(alignmentNodeId); emitter.emit('change', alignmentNodeId, undefined); }
    export function onChange(cb: (id: string, v?: AlignmentVerdict) => void): () => void {
        emitter.on('change', cb);
        return () => emitter.off('change', cb);
    }
    export function satisfies(v: AlignmentVerdict | undefined, required: AlignmentLevel): boolean {
        if (!v) return false;
        if (required === 'strong') return v.level === 'strong';
        if (required === 'weak') return v.level === 'strong' || v.level === 'weak';
        return true;
    }
}
