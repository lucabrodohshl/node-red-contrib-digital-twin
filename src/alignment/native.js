"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAlignmentNative = exports.toArtifactJson = exports.toUppaalXml = void 0;
/**
 * Optional native back-end: delegates the check to the reference C++
 * alignment checker (`run_all_semantic`), if one is available.
 * Views are exported as UPPAAL XML, domain knowledge as its JSON format.
 */
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const ontology_1 = require("./ontology");
const ta_1 = require("./ta");
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cs = (c) => c.map(k => `${k.x} ${k.op} ${k.c}`).join(' && ');
const sym = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
/** Observable labels become UPPAAL send-synchronisations "<label>!", internal ones are plain edges. */
function toUppaalXml(ta, I) {
    const obs = (l) => !(0, ta_1.isInternalLabel)(l) && (!I || !(0, ontology_1.isTau)(I.get(l)));
    const chans = Array.from(new Set(ta.edges.filter(e => obs(e.label)).map(e => sym(e.label))));
    const ids = new Map(ta.locations.map((l, k) => [l.name, `id${k}`]));
    const lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<!DOCTYPE nta PUBLIC '-//Uppaal Team//DTD Flat System 1.6//EN' 'http://www.it.uu.se/research/group/darts/uppaal/flat-1_6.dtd'>",
        '<nta>', `<declaration>${ta.clocks.length ? `clock ${ta.clocks.join(', ')};` : ''}${chans.length ? ` chan ${chans.join(', ')};` : ''}</declaration>`,
        `<template><name>${esc(sym(ta.name))}</name>`,
    ];
    ta.locations.forEach(l => {
        lines.push(`<location id="${ids.get(l.name)}"><name>${esc(sym(l.name))}</name>${l.invariant.length ? `<label kind="invariant">${esc(cs(l.invariant))}</label>` : ''}</location>`);
    });
    lines.push(`<init ref="${ids.get(ta.initial)}"/>`);
    ta.edges.forEach(e => {
        lines.push(`<transition><source ref="${ids.get(e.from)}"/><target ref="${ids.get(e.to)}"/>` +
            (e.guard.length ? `<label kind="guard">${esc(cs(e.guard))}</label>` : '') +
            (obs(e.label) ? `<label kind="synchronisation">${sym(e.label)}!</label>` : '') +
            (e.resets.length ? `<label kind="assignment">${e.resets.map(r => `${r} = 0`).join(', ')}</label>` : '') + '</transition>');
    });
    lines.push('</template>', 'system ' + sym(ta.name) + ';', '</nta>');
    return lines.join('\n');
}
exports.toUppaalXml = toUppaalXml;
/** Domain knowledge in the artifact's JSON format; state formulas are lifted interpretations of location labels. */
function toArtifactJson(phi, pt, dt) {
    const lab = (I, ta) => {
        const r = {};
        ta.edges.forEach(e => { const f = I.get(e.label); if (!(0, ta_1.isInternalLabel)(e.label) && !(0, ontology_1.isTau)(f))
            r[sym(e.label) + '!'] = f; });
        return r;
    };
    const st = (I, ta) => {
        const r = {};
        ta.locations.forEach(l => {
            const fs_ = l.labels.map(a => I.get(a)).filter(f => !(0, ontology_1.isTau)(f));
            if (fs_.length)
                r[sym(l.name)] = fs_.length === 1 ? fs_[0] : `(and ${fs_.join(' ')})`;
        });
        return r;
    };
    const o = phi.ontology;
    return JSON.stringify({
        sorts: [],
        functions: o.functions.filter(f => f.ret !== 'Bool').map(f => ({ name: f.name, args: f.args, return: f.ret })),
        relations: o.functions.filter(f => f.ret === 'Bool').map(f => ({ name: f.name, args: f.args })),
        axioms: o.axioms.map(a => a.formula),
        label_interpretations: { PT: lab(phi.pt, pt), DT: lab(phi.dt, dt) },
        state_interpretations: { PT: st(phi.pt, pt), DT: st(phi.dt, dt) },
    }, null, 2);
}
exports.toArtifactJson = toArtifactJson;
function checkAlignmentNative(binary, pt, dt, phi) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-align-'));
    try {
        const p = path.join(dir, 'pt.xml'), d = path.join(dir, 'dt.xml'), j = path.join(dir, 'phi.json');
        fs.writeFileSync(p, toUppaalXml(pt, phi.pt));
        fs.writeFileSync(d, toUppaalXml(dt, phi.dt));
        fs.writeFileSync(j, toArtifactJson(phi, pt, dt));
        const r = (0, child_process_1.spawnSync)(binary, ['--pair', p, d, j, '--output', path.join(dir, 'out.csv')], { encoding: 'utf8', cwd: dir, maxBuffer: 1 << 26 });
        if (r.error)
            throw new Error(`cannot run native checker '${binary}': ${r.error.message}`);
        const m = (r.stdout || '').match(/Semantic Alignment:\s*(TRUE|FALSE)\s*\(([\d.]+) ms,\s*(\d+) SMT/);
        if (!m)
            throw new Error(`unexpected output of native checker: ${(r.stderr || r.stdout || '').slice(-400)}`);
        return { aligned: m[1] === 'TRUE', timeMs: parseFloat(m[2]), smtCalls: parseInt(m[3], 10), stdout: r.stdout };
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
exports.checkAlignmentNative = checkAlignmentNative;
//# sourceMappingURL=native.js.map