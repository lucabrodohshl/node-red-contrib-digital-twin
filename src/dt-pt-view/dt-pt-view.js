"use strict";
const alignment_1 = require("../alignment");
module.exports = (RED) => {
    function DTPTView(config) {
        RED.nodes.createNode(this, config);
        this.interpretationText = config.interpretation || '';
        this.critical = String(config.critical || '').split(/[,\s]+/).filter(Boolean);
        try {
            this.view = config.format === 'uppaal' ? (0, alignment_1.parseUppaalXml)(config.model, config.template || undefined) : (0, alignment_1.parseTA)(JSON.parse(config.model));
            this.interpretation = (0, alignment_1.parseInterpretation)(this.interpretationText);
        }
        catch (e) {
            this.loadError = e.message;
            this.warn(`dt-pt-view: ${this.loadError}`);
        }
    }
    RED.nodes.registerType('dt-pt-view', DTPTView);
};
//# sourceMappingURL=dt-pt-view.js.map