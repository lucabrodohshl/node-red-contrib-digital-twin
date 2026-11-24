import * as nodered from "node-red"
import { parsePropositions, parseTA } from "../alignment";

/**
 * Timed behaviour of an asset (alignment extension).  Wire the asset to this
 * node; edge labels refer to the asset's dt-action / dt-event names, state
 * propositions are formulas over the asset's properties.
 */
export = (RED: nodered.NodeAPI): void => {
    function DTBehavior(this: nodered.Node, config: any): void {
        RED.nodes.createNode(this, config);
        try {
            const spec = JSON.parse(config.behavior || '{}');
            const ta = parseTA(spec);
            parsePropositions(config.propositions);
            this.status({ fill: 'grey', shape: 'dot', text: `${ta.locations.length} locations, ${ta.edges.length} edges, ${ta.clocks.length} clock${ta.clocks.length === 1 ? "" : "s"}` });
        } catch (e: any) {
            this.status({ fill: 'red', shape: 'ring', text: 'invalid behaviour' });
            this.warn(`dt-behavior: ${e.message}`);
        }
        this.on('input', (msg: any, send, done) => { done(); });
    }
    RED.nodes.registerType('dt-behavior', DTBehavior);
};
