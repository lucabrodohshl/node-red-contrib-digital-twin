"use strict";
module.exports = (RED) => {
    function DTEvent(config) {
        RED.nodes.createNode(this, config);
        this.topic = config.topic;
        this.on('input', (msg, send, done) => {
            send(msg);
        });
    }
    ;
    RED.nodes.registerType('dt-event', DTEvent);
};
//# sourceMappingURL=dt-event.js.map