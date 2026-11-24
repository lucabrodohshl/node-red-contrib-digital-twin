/**
 * Semantic lifting of a Node-RED digital-twin model (Steinmetz et al.) into a
 * DT view (timed automaton) and a DT interpretation over the shared ontology.
 *
 *  - dt-property  : optional `binding`, an ontology term the property denotes
 *                   (e.g. battery := soc); property names may then be used in
 *                   every DT formula of the same asset.
 *  - dt-action /
 *    dt-event     : `interpretation`, the domain condition the label denotes;
 *                   empty means internal (tau).
 *  - dt-behavior  : the asset's timed behaviour (JSON timed automaton) plus
 *                   the meaning of its state propositions.
 */
import { Interpretation, substitute } from './ontology';
import { TASpec, TimedAutomaton, parseTA } from './ta';

export interface FlowNode { id: string; type: string; name?: string; wires?: string[][]; [k: string]: any; }

export interface LiftedAsset {
    asset: FlowNode;
    view: TimedAutomaton;
    interpretation: Interpretation;
    bindings: Map<string, string>;
    warnings: string[];
    members: { properties: FlowNode[]; actions: FlowNode[]; events: FlowNode[]; behavior: FlowNode };
}

/** Nodes attached to an asset, using the same wiring convention as dt-graph. */
export function attachedNodes(flow: FlowNode[], asset: FlowNode): FlowNode[] {
    const outIds = new Set(([] as string[]).concat(...(asset.wires || [])));
    return flow.filter(n => n.id !== asset.id && (outIds.has(n.id) || ([] as string[]).concat(...(n.wires || [])).includes(asset.id)));
}

export function parsePropositions(src: unknown): Map<string, string> {
    const m = new Map<string, string>();
    if (!src) return m;
    if (typeof src === 'object') { Object.entries(src as Record<string, string>).forEach(([k, v]) => m.set(k, v)); return m; }
    const text = String(src).trim();
    if (text.startsWith('{')) return parsePropositions(JSON.parse(text));
    for (const line of text.split(/\r?\n/)) {
        const l = line.replace(/;.*$/, '').trim();
        if (!l) continue;
        const i = l.indexOf(':');
        if (i < 0) throw new Error(`proposition '${l}' must have the form name : formula`);
        m.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
    }
    return m;
}

export function liftAsset(flow: FlowNode[], assetRef: string): LiftedAsset {
    const asset = flow.find(n => n.type === 'dt-asset' && (n.id === assetRef || n.name === assetRef));
    if (!asset) throw new Error(`asset '${assetRef}' not found in the flow`);
    const att = attachedNodes(flow, asset);
    const properties = att.filter(n => n.type === 'dt-property');
    const actions = att.filter(n => n.type === 'dt-action');
    const events = att.filter(n => n.type === 'dt-event');
    const behaviors = att.filter(n => n.type === 'dt-behavior');
    if (behaviors.length !== 1) throw new Error(`asset '${asset.name}' needs exactly one dt-behavior node (found ${behaviors.length})`);
    const behavior = behaviors[0];
    const warnings: string[] = [];

    const bindings = new Map<string, string>();
    for (const p of properties) if (p.binding && String(p.binding).trim()) bindings.set(p.name!, String(p.binding).trim());

    const I: Interpretation = new Map();
    const labels = new Set<string>();
    for (const n of [...actions, ...events]) {
        if (!n.name) { warnings.push(`unnamed ${n.type} ${n.id} ignored`); continue; }
        labels.add(n.name);
        const f = (n.interpretation || '').trim();
        I.set(n.name, f && f !== 'tau' ? substitute(f, bindings) : 'tau');
        if (!f) warnings.push(`${n.type} '${n.name}' has no interpretation: treated as internal (tau)`);
    }
    const spec: TASpec = typeof behavior.behavior === 'string' ? JSON.parse(behavior.behavior) : behavior.behavior;
    spec.name = spec.name || asset.name || 'DT';
    const view = parseTA(spec);
    for (const e of view.edges)
        if (e.label && e.label !== 'tau' && !labels.has(e.label)) {
            I.set(e.label, 'tau');
            if (!warnings.some(w => w.includes(`'${e.label}'`))) warnings.push(`behaviour label '${e.label}' is not an action/event of '${asset.name}': treated as internal (tau)`);
        }
    for (const [ap, f] of parsePropositions(behavior.propositions)) I.set(ap, substitute(f, bindings));
    return { asset, view, interpretation: I, bindings, warnings, members: { properties, actions, events, behavior } };
}
