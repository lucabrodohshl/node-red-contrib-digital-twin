import * as nodered from "node-red"
import { Ontology, parseOntology } from "../alignment";

interface DTOntologyNode extends nodered.Node {
    ontology?: Ontology;
    ontologyText: string;
    version: string;
    loadError?: string;
}

/** Config node holding the shared ontology K = (S, F, R, Delta). */
export = (RED: nodered.NodeAPI): void => {
    function DTOntology(this: any, config: any): void {
        RED.nodes.createNode(this, config);
        this.ontologyText = config.ontology || '';
        this.version = config.version || '1';
        try {
            this.ontology = parseOntology(this.ontologyText, config.name || 'K');
        } catch (e: any) {
            this.loadError = e.message;
            this.loadError && this.warn(`dt-ontology: ${this.loadError}`);
        }
    }
    RED.nodes.registerType('dt-ontology', DTOntology as any);
};
