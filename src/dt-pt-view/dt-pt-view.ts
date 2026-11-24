import * as nodered from "node-red"
import { Interpretation, TimedAutomaton, parseInterpretation, parseTA, parseUppaalXml } from "../alignment";

interface DTPTViewNode extends nodered.Node {
    view?: TimedAutomaton;
    interpretation?: Interpretation;
    interpretationText: string;
    critical: string[];
    loadError?: string;
}

/** Config node holding a PT view (timed automaton) and the PT interpretation over the ontology. */
export = (RED: nodered.NodeAPI): void => {
    function DTPTView(this: any, config: any): void {
        RED.nodes.createNode(this, config);
        this.interpretationText = config.interpretation || '';
        this.critical = String(config.critical || '').split(/[,\s]+/).filter(Boolean);
        try {
            this.view = config.format === 'uppaal' ? parseUppaalXml(config.model, config.template || undefined) : parseTA(JSON.parse(config.model));
            this.interpretation = parseInterpretation(this.interpretationText);
        } catch (e: any) {
            this.loadError = e.message;
            this.warn(`dt-pt-view: ${this.loadError}`);
        }
    }
    RED.nodes.registerType('dt-pt-view', DTPTView as any);
};
