"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
const crypto = __importStar(require("crypto"));
const alignment_1 = require("../alignment");
const alignment_registry_1 = require("../resources/alignment-registry");
const cypher_1 = require("../resources/cypher");
/** Last certified snapshot per dt-alignment node; survives redeploys (node context does not). */
const history = new Map();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
module.exports = (RED) => {
    function DTAlignment(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const collectFlow = () => {
            const flow = [];
            RED.nodes.eachNode((n) => flow.push(n));
            return flow;
        };
        const summary = (r) => ({ aligned: r.aligned, witness: r.witness, stats: r.stats });
        const run = (msg) => {
            const ontNode = RED.nodes.getNode(config.ontology);
            const ptNode = RED.nodes.getNode(config.ptView);
            if (!ontNode || !ontNode.ontology)
                throw new Error((ontNode === null || ontNode === void 0 ? void 0 : ontNode.loadError) || 'no ontology configured');
            if (!ptNode || !ptNode.view)
                throw new Error((ptNode === null || ptNode === void 0 ? void 0 : ptNode.loadError) || 'no PT view configured');
            const candidate = msg && msg.payload && typeof msg.payload === 'object' && msg.payload.behavior;
            let flow = collectFlow();
            if (candidate) {
                // what-if check of a proposed DT update (adaptation / evolution) without deploying it
                flow = flow.map(n => {
                    var _a, _b, _c;
                    return n.type === 'dt-behavior' && ((_c = (_b = (_a = flow.find(a => a.id === config.asset || a.name === config.asset)) === null || _a === void 0 ? void 0 : _a.wires) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.includes(n.id))
                        ? { ...n, behavior: typeof candidate === 'string' ? candidate : JSON.stringify(candidate) } : n;
                });
            }
            const lifted = (0, alignment_1.liftAsset)(flow, config.asset);
            const phi = { ontology: ontNode.ontology, pt: ptNode.interpretation, dt: lifted.interpretation, version: ontNode.version };
            const opts = { critical: ptNode.critical, maxTau: Number(config.maxTau) || 2, z3Path: config.z3Path || undefined };
            const snap = {
                ptHash: sha(JSON.stringify(ptNode.view) + ptNode.interpretationText),
                dtHash: sha(JSON.stringify(lifted.view) + JSON.stringify(Array.from(lifted.interpretation))),
                phiText: ontNode.ontologyText, ptInterp: ptNode.interpretationText,
                dtInterp: Array.from(lifted.interpretation), level: 'none', phiVersion: ontNode.version,
            };
            const last = candidate ? undefined : history.get(node.id);
            const payload = { asset: lifted.asset.name, ptView: ptNode.name || 'PT view', phiVersion: ontNode.version, candidate: !!candidate, warnings: lifted.warnings };
            if (last && last.level !== 'none' && last.ptHash === snap.ptHash && last.dtHash === snap.dtHash && last.phiText !== snap.phiText) {
                const old = { ontology: (0, alignment_1.parseOntology)(last.phiText), pt: (0, alignment_1.parseInterpretation)(last.ptInterp), dt: new Map(last.dtInterp) };
                const ref = (0, alignment_1.checkKnowledgeRefinement)(phi, old, opts.z3Path);
                payload.refinement = ref;
                if (ref.holds) {
                    snap.level = last.level;
                    payload.level = last.level;
                    payload.reusedByRefinement = true;
                }
            }
            if (!payload.reusedByRefinement) {
                const strong = (0, alignment_1.checkAlignment)(ptNode.view, lifted.view, phi, { ...opts, mode: 'strong' });
                payload.strong = summary(strong);
                payload.labelEquivalence = strong.labelEquivalence;
                payload.propositionEquivalence = strong.propositionEquivalence;
                if (strong.aligned)
                    snap.level = 'strong';
                else {
                    const weak = (0, alignment_1.checkAlignment)(ptNode.view, lifted.view, phi, { ...opts, mode: 'weak' });
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
                alignment_registry_1.AlignmentRegistry.set(node.id, {
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
        const toCypher = (lifted, payload, level) => {
            const view = (0, cypher_1.esc)(payload.ptView);
            const c = [
                `MERGE (v:PTView {name: '${view}'})`,
                `MATCH (a:Asset {nodered_id: '${(0, cypher_1.esc)(lifted.asset.id)}'}) MATCH (v:PTView {name: '${view}'}) MERGE (a)-[r:ALIGNED_WITH]->(v) SET r.level = '${level}', r.ontology_version = '${(0, cypher_1.esc)(payload.phiVersion)}', r.checked_at = '${new Date().toISOString()}', r.reused = ${!!payload.reusedByRefinement}`,
            ];
            const byName = new Map([...lifted.members.actions, ...lifted.members.events].map(n => [n.name, n]));
            for (const p of payload.labelEquivalence || []) {
                const n = byName.get(p.dt);
                if (!n)
                    continue;
                const lbl = n.type === 'dt-action' ? 'Action' : 'Event';
                c.push(`MATCH (e:${lbl} {nodered_id: '${(0, cypher_1.esc)(n.id)}'}) MERGE (l:PTLabel {name: '${(0, cypher_1.esc)(p.pt)}', view: '${view}'}) MERGE (e)-[:DOMAIN_EQUIVALENT]->(l)`);
            }
            return c;
        };
        node.on('input', (msg, send, done) => {
            try {
                const r = run(msg);
                msg.payload = r.payload;
                msg.cypher = r.cypher;
                send(msg);
                done();
            }
            catch (e) {
                node.status({ fill: 'red', shape: 'ring', text: `error: ${String(e.message).slice(0, 60)}` });
                alignment_registry_1.AlignmentRegistry.clear(node.id);
                done(e);
            }
        });
        // flows are started once every node exists: check right after deploy
        const timer = setTimeout(() => node.receive({ topic: 'deploy' }), 100);
        node.on('close', () => clearTimeout(timer));
    }
    RED.nodes.registerType('dt-alignment', DTAlignment);
};
//# sourceMappingURL=dt-alignment.js.map