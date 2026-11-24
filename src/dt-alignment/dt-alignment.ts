import * as nodered from "node-red"
import * as crypto from "crypto";
import { AlignmentResult, DomainKnowledge, LiftedAsset, checkAlignment, checkKnowledgeRefinement, liftAsset, parseInterpretation, parseOntology } from "../alignment";
import { AlignmentLevel, AlignmentRegistry } from "../resources/alignment-registry";
import { esc } from "../resources/cypher";

interface Snapshot { ptHash: string; dtHash: string; phiText: string; ptInterp: string; dtInterp: Array<[string, string]>; level: AlignmentLevel; phiVersion: string; }

/** Last certified snapshot per dt-alignment node; survives redeploys (node context does not). */
const history = new Map<string, Snapshot>();

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Checks (design time, on every deploy) that the DT model of an asset is
 * semantically aligned with its PT view under the shared ontology, reuses the
 * verdict across conservative ontology evolution (knowledge refinement), publishes the
 * verdict for dt-align-gate and emits Cypher that records it in the knowledge graph.
 */
export = (RED: nodered.NodeAPI): void => {
    function DTAlignment(this: nodered.Node, config: any): void {
        RED.nodes.createNode(this, config);
        const node = this;

        const collectFlow = (): any[] => {
            const flow: any[] = [];
            (RED.nodes as any).eachNode((n: any) => flow.push(n));
            return flow;
        };

        const summary = (r: AlignmentResult) => ({ aligned: r.aligned, witness: r.witness, stats: r.stats });

        const run = (msg: any) => {
            const ontNode: any = RED.nodes.getNode(config.ontology);
            const ptNode: any = RED.nodes.getNode(config.ptView);
            if (!ontNode || !ontNode.ontology) throw new Error(ontNode?.loadError || 'no ontology configured');
            if (!ptNode || !ptNode.view) throw new Error(ptNode?.loadError || 'no PT view configured');
            const candidate = msg && msg.payload && typeof msg.payload === 'object' && msg.payload.behavior;
            let flow = collectFlow();
            if (candidate) {
                // what-if check of a proposed DT update (adaptation / evolution) without deploying it
                flow = flow.map(n => n.type === 'dt-behavior' && flow.find(a => a.id === config.asset || a.name === config.asset)?.wires?.[0]?.includes(n.id)
                    ? { ...n, behavior: typeof candidate === 'string' ? candidate : JSON.stringify(candidate) } : n);
            }
            const lifted: LiftedAsset = liftAsset(flow, config.asset);
            const phi: DomainKnowledge = { ontology: ontNode.ontology, pt: ptNode.interpretation, dt: lifted.interpretation, version: ontNode.version };
            const opts = { critical: ptNode.critical, maxTau: Number(config.maxTau) || 2, z3Path: config.z3Path || undefined };
            const snap: Snapshot = {
                ptHash: sha(JSON.stringify(ptNode.view) + ptNode.interpretationText),
                dtHash: sha(JSON.stringify(lifted.view) + JSON.stringify(Array.from(lifted.interpretation))),
                phiText: ontNode.ontologyText, ptInterp: ptNode.interpretationText,
                dtInterp: Array.from(lifted.interpretation), level: 'none', phiVersion: ontNode.version,
            };
            const last: Snapshot | undefined = candidate ? undefined : history.get(node.id);
            const payload: any = { asset: lifted.asset.name, ptView: ptNode.name || 'PT view', phiVersion: ontNode.version, candidate: !!candidate, warnings: lifted.warnings };

            if (last && last.level !== 'none' && last.ptHash === snap.ptHash && last.dtHash === snap.dtHash && last.phiText !== snap.phiText) {
                const old: DomainKnowledge = { ontology: parseOntology(last.phiText), pt: parseInterpretation(last.ptInterp), dt: new Map(last.dtInterp) };
                const ref = checkKnowledgeRefinement(phi, old, opts.z3Path);
                payload.refinement = ref;
                if (ref.holds) {
                    snap.level = last.level;
                    payload.level = last.level;
                    payload.reusedByRefinement = true;
                }
            }
            if (!payload.reusedByRefinement) {
                const strong = checkAlignment(ptNode.view, lifted.view, phi, { ...opts, mode: 'strong' });
                payload.strong = summary(strong);
                payload.labelEquivalence = strong.labelEquivalence;
                payload.propositionEquivalence = strong.propositionEquivalence;
                if (strong.aligned) snap.level = 'strong';
                else {
                    const weak = checkAlignment(ptNode.view, lifted.view, phi, { ...opts, mode: 'weak' });
                    payload.weak = summary(weak);
                    snap.level = weak.aligned ? 'weak' : 'none';
                }
                payload.level = snap.level;
                payload.reusedByRefinement = false;
                payload.witness = payload.strong.witness;
            }
            payload.aligned = snap.level === 'strong';

            if (!candidate) {
                history.set(node.id, snap);
                AlignmentRegistry.set(node.id, {
                    level: snap.level, asset: lifted.asset.name || config.asset, ptView: payload.ptView, phiVersion: ontNode.version,
                    checkedAt: new Date().toISOString(), reusedByRefinement: payload.reusedByRefinement,
                    witness: payload.witness ? payload.witness.message : undefined,
                });
                const txt = snap.level === 'strong' ? 'strongly aligned' : snap.level === 'weak' ? 'weakly aligned only' : `misaligned (${payload.witness ? payload.witness.kind : 'refinement'})`;
                node.status({ fill: snap.level === 'strong' ? 'green' : snap.level === 'weak' ? 'yellow' : 'red', shape: snap.level === 'none' ? 'ring' : 'dot',
                    text: `${txt} | K v${ontNode.version}${payload.reusedByRefinement ? ' (reused: K′⊑K)' : ''}` });
            }
            return { payload, cypher: candidate ? [] : toCypher(lifted, payload, snap.level) };
        };

        const toCypher = (lifted: LiftedAsset, payload: any, level: AlignmentLevel): string[] => {
            const view = esc(payload.ptView);
            const c = [
                `MERGE (v:PTView {name: '${view}'})`,
                `MATCH (a:Asset {nodered_id: '${esc(lifted.asset.id)}'}) MATCH (v:PTView {name: '${view}'}) MERGE (a)-[r:ALIGNED_WITH]->(v) SET r.level = '${level}', r.ontology_version = '${esc(payload.phiVersion)}', r.checked_at = '${new Date().toISOString()}', r.reused = ${!!payload.reusedByRefinement}`,
            ];
            const byName = new Map([...lifted.members.actions, ...lifted.members.events].map(n => [n.name, n]));
            for (const p of payload.labelEquivalence || []) {
                const n = byName.get(p.dt);
                if (!n) continue;
                const lbl = n.type === 'dt-action' ? 'Action' : 'Event';
                c.push(`MATCH (e:${lbl} {nodered_id: '${esc(n.id)}'}) MERGE (l:PTLabel {name: '${esc(p.pt)}', view: '${view}'}) MERGE (e)-[:DOMAIN_EQUIVALENT]->(l)`);
            }
            return c;
        };

        node.on('input', (msg: any, send, done) => {
            try {
                const r = run(msg);
                msg.payload = r.payload;
                msg.cypher = r.cypher;
                send(msg);
                done();
            } catch (e: any) {
                node.status({ fill: 'red', shape: 'ring', text: `error: ${String(e.message).slice(0, 60)}` });
                AlignmentRegistry.clear(node.id);
                done(e);
            }
        });

        // flows are started once every node exists: check right after deploy
        const timer = setTimeout(() => (node as any).receive({ topic: 'deploy' }), 100);
        node.on('close', () => clearTimeout(timer));
    }
    RED.nodes.registerType('dt-alignment', DTAlignment);
};
