#!/usr/bin/env node
/**
 * Builds the Node-RED flow of the drone digital twin (drone-flow.json).
 * The DT is modelled with the original nodes of node-red-contrib-digital-twin
 * (dt-asset, dt-property, dt-action, dt-event, dt-graph) plus the alignment
 * extension (interpretations/bindings, dt-behavior, dt-ontology, dt-pt-view,
 * dt-alignment, dt-align-gate).
 */
const fs = require('fs');
const path = require('path');
const here = (f) => path.join(__dirname, f);

function droneBehavior(overrides = {}) {
    return {
        name: 'DroneDT',
        clocks: ['t'],
        initial: 'Ready',
        locations: [
            { name: 'Ready', labels: ['onGround'] },
            { name: 'Ascending', invariant: 't <= 8', labels: ['flying'] },
            { name: 'Spraying', invariant: `t <= ${overrides.cellBound || 30}`, labels: ['flying', 'dispensing'] },
            { name: 'Returning', invariant: 't <= 20', labels: ['flying', 'homing'] },
            ...(overrides.extraLocations || []),
        ],
        edges: [
            { from: 'Ready', to: 'Ascending', label: 'takeOff', reset: 't' },
            { from: 'Ready', to: 'Ready', label: 'optimizeRoute' },
            { from: 'Ascending', to: 'Spraying', label: 'sprayStarted', guard: 't >= 3', reset: 't' },
            { from: 'Spraying', to: 'Spraying', label: 'cellCompleted', guard: 't >= 10', reset: 't' },
            { from: 'Spraying', to: 'Spraying', label: 'logTelemetry' },
            { from: 'Spraying', to: 'Returning', label: 'lowBattery', reset: 't' },
            { from: 'Spraying', to: 'Returning', label: 'missionComplete', guard: 't >= 10', reset: 't' },
            { from: 'Returning', to: 'Ready', label: 'touchdown', guard: 't >= 5' },
            ...(overrides.extraEdges || []),
        ],
    };
}

const PROPOSITIONS = [
    'onGround   : (<= altitude 0)',
    'flying     : (> altitude 0)',
    'dispensing : (> pumpFlow 0)',
    'homing     : rtb_active',
].join('\n');

/**
 * Returns the flow. `v` customises the DT model to produce the evaluation variants.
 */
function buildFlow(v = {}) {
    const z = 'drone_tab';
    const I = Object.assign({
        takeOff: 'armed',
        sprayStarted: '(> pumpFlow 0)',
        cellCompleted: 'cell_complete',
        lowBattery: '(< battery 25)',
        missionComplete: '(not (< cellsSprayed 9))',
        touchdown: '(<= altitude 0)',
    }, v.interpretations || {});
    const prop = (id, name, binding, aType, y) => ({ id, type: 'dt-property', z, name, binding, aType, aContext: 'https://saref.etsi.org/core/', aId: '', accessGroup: 'operator', x: 130, y, wires: [['drone']] });
    const act = (id, type, name, y, extra = {}) => ({ id, type, z, name, interpretation: I[name] ?? '', aType: type === 'dt-action' ? 'saref:Command' : 'saref:Event', aContext: '', aId: '', accessGroup: 'operator', topic: `drone/${name}`, x: 560, y, wires: [[]], ...extra });
    const nodes = [
        { id: z, type: 'tab', label: 'Drone digital twin', disabled: false, info: '' },
        { id: 'graph', type: 'dt-graph', z, name: 'knowledge graph', projectName: 'smart-farming', projectId: 'sf-001', version: v.version || '1.0.0+1', x: 130, y: 40, wires: [['kg_out']] },
        { id: 'kg_out', type: 'debug', z, name: 'cypher', active: true, tosidebar: true, complete: 'payload', x: 320, y: 40, wires: [] },
        { id: 'drone', type: 'dt-asset', z, name: 'drone', aDTType: 'Equipment', aContext: 'https://saref.etsi.org/saref4agri/', aId: 'urn:drone:07', aType: 'saref4agri:Drone', accessGroup: 'operator', x: 330, y: 170, wires: [['takeOff', 'sprayStarted', 'cellCompleted', 'lowBattery', 'missionComplete', 'touchdown', 'behavior', 'partOf', ...(v.extraActionIds || [])]] },
        prop('battery', 'battery', 'soc', 'saref:StateOfCharge', 110),
        prop('altitude', 'altitude', 'alt', 'saref:Altitude', 150),
        prop('pumpFlow', 'pumpFlow', 'flow', 'saref:FlowRate', 190),
        prop('cellsSprayed', 'cellsSprayed', 'covered', 'saref:Count', 230),
        act('takeOff', 'dt-action', 'takeOff', 80),
        act('sprayStarted', 'dt-event', 'sprayStarted', 120),
        act('cellCompleted', 'dt-event', 'cellCompleted', 160),
        act('lowBattery', 'dt-event', 'lowBattery', 200),
        act('missionComplete', 'dt-event', 'missionComplete', 240),
        act('touchdown', 'dt-event', 'touchdown', 280),
        ...(v.extraActions || []).map((a, k) => act(a.id, 'dt-action', a.name, 360 + 40 * k)),
        { id: 'behavior', type: 'dt-behavior', z, name: 'drone behaviour', behavior: JSON.stringify(droneBehavior(v.behavior), null, 2), propositions: PROPOSITIONS, x: 560, y: 330, wires: [[]] },
        { id: 'partOf', type: 'dt-relation', z, name: 'partOf', direction: '-->', x: 560, y: 380, wires: [['fleet']] },
        { id: 'fleet', type: 'dt-asset', z, name: 'fleet', x: 740, y: 380, wires: [[]] },
        // --- alignment extension ---
        { id: 'phi', type: 'dt-ontology', name: 'drone ontology', version: v.ontologyVersion || '1', ontology: v.ontologyText || fs.readFileSync(here('drone.ont'), 'utf8') },
        { id: 'ptview', type: 'dt-pt-view', name: 'flight controller (PT)', format: 'json', model: fs.readFileSync(here('pt.json'), 'utf8'), interpretation: fs.readFileSync(here('pt.interp'), 'utf8'), critical: 'bat_low!' },
        { id: 'align', type: 'dt-alignment', z, name: 'PT/DT alignment', asset: 'drone', ontology: 'phi', ptView: 'ptview', mode: 'strong', maxTau: 2, z3Path: '', x: 140, y: 450, wires: [['align_out']] },
        { id: 'align_out', type: 'debug', z, name: 'alignment verdict', active: true, tosidebar: true, console: true, complete: 'payload', x: 380, y: 450, wires: [] },
        { id: 'whatif', type: 'inject', z, name: 'what-if: 40 s cells', props: [{ p: 'payload' }], payload: JSON.stringify({ behavior: droneBehavior({ cellBound: 40 }) }), payloadType: 'json', repeat: '', once: false, x: 140, y: 400, wires: [['align']] },
        { id: 'opt', type: 'inject', z, name: 'optimizer: commit next cell', props: [{ p: 'payload' }], payload: '{"action":"commitCell","cell":5}', payloadType: 'json', repeat: '', once: true, onceDelay: '2', x: 160, y: 520, wires: [['gate']] },
        { id: 'gate', type: 'dt-align-gate', z, name: 'aligned?', alignment: 'align', require: 'strong', x: 400, y: 520, wires: [['to_pt'], ['blocked']] },
        { id: 'to_pt', type: 'debug', z, name: 'to PT (accepted)', active: true, tosidebar: true, console: true, complete: 'payload', x: 600, y: 500, wires: [] },
        { id: 'blocked', type: 'debug', z, name: 'blocked', active: true, tosidebar: true, console: true, complete: 'true', x: 590, y: 540, wires: [] },
    ];
    return nodes;
}

module.exports = { buildFlow, droneBehavior };

if (require.main === module) {
    fs.writeFileSync(here('drone-flow.json'), JSON.stringify(buildFlow(), null, 2));
    console.log('wrote', here('drone-flow.json'));
}
