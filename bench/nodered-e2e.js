#!/usr/bin/env node
/**
 * End-to-end scenario in a real Node-RED runtime (admin API redeploys):
 *   1. deploy V0                   -> strongly aligned, optimiser command forwarded
 *   2. redeploy with ontology E1   -> verdict reused via knowledge refinement
 *   3. redeploy with DT variant V1 -> misaligned, optimiser command blocked
 *   4. what-if: candidate behaviour V3 sent to dt-alignment -> weak only, not published
 * Usage: node bench/nodered-e2e.js <node-red userDir>   (package installed there)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildFlow } = require('../examples/drone/build-flow');

const userDir = process.argv[2];
const port = 18802;
const ex = (f) => fs.readFileSync(path.join(__dirname, '..', 'examples', 'drone', f), 'utf8');

function post(p, body, headers = {}) {
    return new Promise((res, rej) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
        req.on('error', rej);
        req.end(data);
    });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    fs.writeFileSync(path.join(userDir, 'flows.json'), JSON.stringify(buildFlow({})));
    const nr = spawn('node-red', ['-u', userDir, '-p', String(port), 'flows.json'], { cwd: userDir });
    let log = '';
    nr.stdout.on('data', d => (log += d));
    nr.stderr.on('data', d => (log += d));
    const mark = (s) => { log += `\n##### ${s}\n`; };
    try {
        for (let k = 0; k < 40 && !/Started flows/.test(log); k++) await sleep(250);
        await sleep(2500); // initial check + optimiser inject (once, after 2 s)
        mark('E1: ontology v2 (wind limits), DT unchanged');
        await post('/flows', buildFlow({ ontologyText: ex('drone_v2_wind.ont'), ontologyVersion: '2' }), { 'Node-RED-Deployment-Type': 'full' });
        await sleep(2800);
        mark('what-if: candidate behaviour with 40 s cells (V3), not deployed');
        await post('/inject/whatif', {});
        await sleep(500);
        mark('V1: DT lowBattery threshold drift');
        await post('/flows', buildFlow({ ontologyText: ex('drone_v2_wind.ont'), ontologyVersion: '2', interpretations: { lowBattery: '(< battery 20)' } }), { 'Node-RED-Deployment-Type': 'full' });
        await sleep(2800);
    } finally {
        nr.kill('SIGINT');
        await sleep(800);
    }
    // summarise
    const lines = log.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#####')) out.push(l);
        if (/\[debug:(to PT|blocked)/.test(l)) out.push(l.replace(/^.*\[debug:/, '[') + ' ' + (lines[i + 1] || '').trim());
        if (/^\s*(level|reusedByRefinement|candidate|holds): /.test(l)) out.push('   ' + l.trim());
        if (/^\s*message: /.test(l) && out.length) out.push('   ' + l.trim().slice(0, 220));
    }
    console.log(out.join('\n'));
    fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'results', 'nodered_e2e.log'), log);
})();
