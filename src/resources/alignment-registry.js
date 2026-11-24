"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlignmentRegistry = void 0;
const events_1 = require("events");
const verdicts = new Map();
const emitter = new events_1.EventEmitter();
/** Shared between dt-alignment (writer) and dt-align-gate (reader). */
var AlignmentRegistry;
(function (AlignmentRegistry) {
    function set(alignmentNodeId, v) {
        verdicts.set(alignmentNodeId, v);
        emitter.emit('change', alignmentNodeId, v);
    }
    AlignmentRegistry.set = set;
    function get(alignmentNodeId) { return verdicts.get(alignmentNodeId); }
    AlignmentRegistry.get = get;
    function clear(alignmentNodeId) { verdicts.delete(alignmentNodeId); emitter.emit('change', alignmentNodeId, undefined); }
    AlignmentRegistry.clear = clear;
    function onChange(cb) {
        emitter.on('change', cb);
        return () => emitter.off('change', cb);
    }
    AlignmentRegistry.onChange = onChange;
    function satisfies(v, required) {
        if (!v)
            return false;
        if (required === 'strong')
            return v.level === 'strong';
        if (required === 'weak')
            return v.level === 'strong' || v.level === 'weak';
        return true;
    }
    AlignmentRegistry.satisfies = satisfies;
})(AlignmentRegistry || (exports.AlignmentRegistry = AlignmentRegistry = {}));
//# sourceMappingURL=alignment-registry.js.map