"use strict";
module.exports = (RED) => {
    function DTProperty(config) {
        RED.nodes.createNode(this, config);
        this.accessGroup = config.accessGroup;
        this.aContext = config.aContext;
        this.aId = config.aId;
        this.aType = config.aType;
        var node = this;
        this.on('input', (msg, send, done) => {
            node.value = msg.payload;
            let data = {
                payload: node,
            };
            send(data);
        });
    }
    ;
    RED.nodes.registerType('dt-property', DTProperty);
};
//# sourceMappingURL=dt-property.js.map