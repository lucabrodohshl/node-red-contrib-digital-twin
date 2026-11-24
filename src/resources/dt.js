"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DT = void 0;
const events_1 = require("events");
const _myEmitter = new events_1.EventEmitter();
var DT;
(function (DT) {
    let events;
    (function (events) {
        events.on = _myEmitter.on.bind(_myEmitter);
        events.emit = _myEmitter.emit.bind(_myEmitter);
        events.listenerCount = _myEmitter.listenerCount.bind(_myEmitter);
        events.listeners = _myEmitter.listeners.bind(_myEmitter);
    })(events = DT.events || (DT.events = {}));
    let eventNames;
    (function (eventNames) {
        eventNames.updateAsset = 'updateAsset';
        eventNames.actionCall = 'actionCall';
    })(eventNames = DT.eventNames || (DT.eventNames = {}));
})(DT || (exports.DT = DT = {}));
//# sourceMappingURL=dt.js.map