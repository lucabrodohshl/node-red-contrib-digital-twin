"use strict";
const alignment_registry_1 = require("../resources/alignment-registry");
module.exports = (RED) => {
    function DTAlignGate(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const required = config.require === 'weak' ? 'weak' : 'strong';
        const show = () => {
            const v = alignment_registry_1.AlignmentRegistry.get(config.alignment);
            const ok = alignment_registry_1.AlignmentRegistry.satisfies(v, required);
            node.status({ fill: ok ? 'green' : 'red', shape: ok ? 'dot' : 'ring', text: v ? `${ok ? 'open' : 'closed'}: DT ${v.level}ly aligned`.replace('nonely aligned', 'misaligned') : 'closed: no verdict' });
        };
        const off = alignment_registry_1.AlignmentRegistry.onChange(id => { if (id === config.alignment)
            show(); });
        show();
        node.on('input', (msg, send, done) => {
            const v = alignment_registry_1.AlignmentRegistry.get(config.alignment);
            msg.alignment = v || { level: 'none' };
            if (alignment_registry_1.AlignmentRegistry.satisfies(v, required))
                send([msg, null]);
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
//# sourceMappingURL=dt-align-gate.js.map