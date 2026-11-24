"use strict";
const dt_1 = require("../resources/dt");
module.exports = (RED) => {
    function DTAsset(config) {
        RED.nodes.createNode(this, config);
        this.on('input', (msg, send, done) => {
            let data = {
                property: msg.payload,
                assetId: this.id,
            };
            dt_1.DT.events.emit(dt_1.DT.eventNames.updateAsset, data);
        });
    }
    ;
    RED.nodes.registerType('dt-asset', DTAsset);
};
//# sourceMappingURL=dt-asset.js.map