import * as nodered from "node-red"
import { AlignmentLevel, AlignmentRegistry } from "../resources/alignment-registry";

/**
 * Forwards decisions derived from the DT (optimisation setpoints, adaptation
 * commands, update proposals) to the PT only while the DT is aligned at the
 * required level; otherwise routes them to the second output.
 */
export = (RED: nodered.NodeAPI): void => {
    function DTAlignGate(this: nodered.Node, config: any): void {
        RED.nodes.createNode(this, config);
        const node = this;
        const required: AlignmentLevel = config.require === 'weak' ? 'weak' : 'strong';
        const show = () => {
            const v = AlignmentRegistry.get(config.alignment);
            const ok = AlignmentRegistry.satisfies(v, required);
            node.status({ fill: ok ? 'green' : 'red', shape: ok ? 'dot' : 'ring', text: v ? `${ok ? 'open' : 'closed'}: DT ${v.level}ly aligned`.replace('nonely aligned', 'misaligned') : 'closed: no verdict' });
        };
        const off = AlignmentRegistry.onChange(id => { if (id === config.alignment) show(); });
        show();
        node.on('input', (msg: any, send, done) => {
            const v = AlignmentRegistry.get(config.alignment);
            msg.alignment = v || { level: 'none' };
            if (AlignmentRegistry.satisfies(v, required)) send([msg, null]);
            else {
                msg.blockedBecause = v ? `DT is ${v.level === 'none' ? 'misaligned' : v.level + 'ly aligned'}, ${required} alignment required${v.witness ? ': ' + v.witness : ''}` : 'no alignment verdict';
                send([null, msg]);
            }
            done();
        });
        node.on('close', off);
    }
    RED.nodes.registerType('dt-align-gate', DTAlignGate);
};
