"use strict";
const dt_1 = require("../resources/dt");
const cypher_1 = require("../resources/cypher");
const cypherConverter = new cypher_1.Cypher();
var graphNode;
function processNode(asset, node, nodes, relationsMap) {
    switch (node.type) {
        case 'dt-property':
            if (!asset.properties)
                asset.properties = [];
            asset.properties.push(node);
            break;
        case 'dt-action':
            if (!asset.actions)
                asset.actions = [];
            asset.actions.push(node);
            break;
        case 'dt-event':
            if (!asset.events)
                asset.events = [];
            asset.events.push(node);
            break;
        case 'dt-model':
            break;
        case 'dt-behavior':
            // timed behaviour of the asset (alignment extension); stored with the model
            asset.behavior = { id: node.id, name: node.name };
            break;
        case 'dt-relation':
            let relationNode = node;
            let outgoingNodes = nodes.filter(n => relationNode.wires[0].includes(n.id));
            let incomingNodes = nodes.filter(n => n.wires[0].includes(relationNode.id));
            let isAssetsRelation = !(outgoingNodes.find(e => !e.type.startsWith('dt-asset')) &&
                incomingNodes.find(e => !e.type.startsWith('dt-asset')));
            if (isAssetsRelation) {
                relationsMap.set(node.id, {
                    id: relationNode.id,
                    name: relationNode.name,
                    direction: relationNode.direction,
                    origins: incomingNodes,
                    targets: outgoingNodes,
                });
            }
            break;
        default:
            throw new Error(`Not allowed connection to ${node.type}`);
    }
}
function modelToCypher(assets, relations) {
    return cypherConverter.convertAssetsRelations(assets, relations);
}
function deletedNodesCypher(nodes) {
    return cypherConverter.deletedNodesCypher(nodes);
}
function propertyToCypher(propertyNode) {
    return [cypherConverter.createDataPropertyCypher(propertyNode)];
}
module.exports = (RED) => {
    // receive updates from the Editor (model changes)
    RED.httpNode.post('/dt-graph', (req, res) => {
        if (req.body.action == 'deploy') {
            let deletedNodes = JSON.parse(req.body.deletedNodes);
            let assets = [];
            let relationsMap = new Map();
            let nodes = JSON.parse(req.body.nodes);
            let assetsNodes = nodes.filter(n => n.type.startsWith('dt-asset'));
            if (assetsNodes.length == 0) {
                throw new Error('No assets found');
            }
            for (let assetNode of assetsNodes) {
                let asset = assetNode;
                let outGoingConnections = nodes.filter(n => assetNode.wires[0].includes(n.id));
                let inComingConnections = nodes.filter(n => n.wires[0].includes(assetNode.id));
                for (let node of outGoingConnections) {
                    processNode(asset, node, nodes, relationsMap);
                }
                for (let node of inComingConnections) {
                    processNode(asset, node, nodes, relationsMap);
                }
                assets.push(asset);
            }
            let relations = Array.from(relationsMap.values());
            let cypher = modelToCypher(assets, relations);
            let deletedNodesC = deletedNodesCypher(deletedNodes);
            cypher.push(...deletedNodesC);
            let payload = {
                'model': {
                    'projectName': graphNode.projectName,
                    'projectId': graphNode.projectId,
                    'version': graphNode.version,
                    'assets': assets,
                    'relations': relations,
                    'deletedNodes': deletedNodes
                },
                'cypher': cypher
            };
            let message = {
                payload: payload,
            };
            graphNode.send(message);
            deletedNodes = [];
        }
        else if (req.body.action == 'node_deleted') {
            // deletedNodes.push(req.body.node);
            //TODO: delete node from db 
            //      or keep it in memory for when deploy is called
        }
        else if (req.body.action == 'node_added') {
        }
        res.sendStatus(200);
    });
    dt_1.DT.events.on(dt_1.DT.eventNames.updateAsset, (msg) => {
        let property = msg.property;
        let cypher = propertyToCypher(property);
        let payload = {
            'data': {
                'asset_id': msg.assetId,
                'property': property
            },
            'cypher': cypher
        };
        let message = {
            payload: payload,
        };
        graphNode.send(message);
    });
    function DTGraph(config) {
        RED.nodes.createNode(this, config);
        graphNode = this;
        graphNode.projectName = config.projectName;
        graphNode.projectId = config.projectId;
        graphNode.version = config.version;
    }
    ;
    RED.nodes.registerType('dt-graph', DTGraph);
};
//# sourceMappingURL=dt-graph.js.map