"use strict";
const alignment_1 = require("../alignment");
module.exports = (RED) => {
    function DTOntology(config) {
        RED.nodes.createNode(this, config);
        this.ontologyText = config.ontology || '';
        this.version = config.version || '1';
        try {
            this.ontology = (0, alignment_1.parseOntology)(this.ontologyText, config.name || 'K');
        }
        catch (e) {
            this.loadError = e.message;
            this.loadError && this.warn(`dt-ontology: ${this.loadError}`);
        }
    }
    RED.nodes.registerType('dt-ontology', DTOntology);
};
//# sourceMappingURL=dt-ontology.js.map