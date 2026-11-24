"use strict";
const alignment_1 = require("../alignment");
module.exports = (RED) => {
    function DTBehavior(config) {
        RED.nodes.createNode(this, config);
        try {
            const spec = JSON.parse(config.behavior || '{}');
            const ta = (0, alignment_1.parseTA)(spec);
            (0, alignment_1.parsePropositions)(config.propositions);
            this.status({ fill: 'grey', shape: 'dot', text: `${ta.locations.length} locations, ${ta.edges.length} edges, ${ta.clocks.length} clock${ta.clocks.length === 1 ? "" : "s"}` });
        }
        catch (e) {
            this.status({ fill: 'red', shape: 'ring', text: 'invalid behaviour' });
            this.warn(`dt-behavior: ${e.message}`);
        }
        this.on('input', (msg, send, done) => { done(); });
    }
    RED.nodes.registerType('dt-behavior', DTBehavior);
};
//# sourceMappingURL=dt-behavior.js.map