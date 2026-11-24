#!/usr/bin/env node
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
exports.loadKnowledge = exports.loadView = void 0;
/**
 * dt-align --pt <pt.json|pt.xml> --dt <dt.json|dt.xml> --ontology <K.ont>
 *          --pt-interp <pt.interp> --dt-interp <dt.interp>
 *          [--mode strong|weak] [--syntactic] [--critical a,b] [--json]
 * dt-align --refines --ontology <new.ont> --pt-interp ... --dt-interp ...
 *          --old-ontology <old.ont> --old-pt-interp ... --old-dt-interp ...
 */
const fs = __importStar(require("fs"));
const checker_1 = require("./checker");
const ontology_1 = require("./ontology");
const refinement_1 = require("./refinement");
const ta_1 = require("./ta");
function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (n) => process.argv.includes(n);
const need = (n) => { const v = arg(n); if (!v) {
    console.error(`missing ${n}`);
    process.exit(2);
} return v; };
function loadView(file) {
    const txt = fs.readFileSync(file, 'utf8');
    return file.endsWith('.xml') ? (0, ta_1.parseUppaalXml)(txt) : (0, ta_1.parseTA)(JSON.parse(txt));
}
exports.loadView = loadView;
function loadKnowledge(ont, pti, dti) {
    return {
        ontology: (0, ontology_1.parseOntology)(fs.readFileSync(ont, 'utf8'), ont),
        pt: (0, ontology_1.parseInterpretation)(fs.readFileSync(pti, 'utf8')),
        dt: (0, ontology_1.parseInterpretation)(fs.readFileSync(dti, 'utf8')),
    };
}
exports.loadKnowledge = loadKnowledge;
function main() {
    var _a;
    if (flag('--refines')) {
        const r = (0, refinement_1.checkKnowledgeRefinement)(loadKnowledge(need('--ontology'), need('--pt-interp'), need('--dt-interp')), loadKnowledge(need('--old-ontology'), need('--old-pt-interp'), need('--old-dt-interp')));
        console.log(flag('--json') ? JSON.stringify(r, null, 2) : `Phi' refines Phi: ${r.holds}\n` + r.violations.map(v => ` (${v.condition}) ${v.item}: ${v.detail} ${v.countermodel ? JSON.stringify(v.countermodel) : ''}`).join('\n'));
        process.exit(r.holds ? 0 : 1);
    }
    const syntactic = flag('--syntactic');
    const phi = syntactic ? null : loadKnowledge(need('--ontology'), need('--pt-interp'), need('--dt-interp'));
    const res = (0, checker_1.checkAlignment)(loadView(need('--pt')), loadView(need('--dt')), phi, {
        mode: arg('--mode') || 'strong', matching: syntactic ? 'syntactic' : 'semantic',
        critical: (_a = arg('--critical')) === null || _a === void 0 ? void 0 : _a.split(',').filter(Boolean),
        maxTau: arg('--max-tau') ? parseInt(arg('--max-tau'), 10) : undefined,
    });
    if (flag('--json'))
        console.log(JSON.stringify(res, null, 2));
    else {
        console.log(`${res.mode} ${res.matching} alignment: ${res.aligned ? 'ALIGNED' : 'NOT ALIGNED'}`);
        console.log(`  |E|=${res.stats.labelPairsInE} smt=${res.stats.smtCalls} product=${res.stats.productNodes} relation=${res.stats.relationSize} time=${res.stats.timeMs}ms`);
        if (res.witness) {
            console.log(`  witness (${res.witness.kind}): ${res.witness.message}`);
            res.witness.trace.forEach((s, k) => console.log(`   ${k}. (${s.pt}, ${s.dt}) ${s.move || ''} ${s.clocks ? '@ ' + s.clocks : ''}`));
            res.witness.countermodels.forEach(c => console.log(`   countermodel ${c.pt} vs ${c.dt}: ${JSON.stringify(c.model)}`));
        }
    }
    process.exit(res.aligned ? 0 : 1);
}
if (require.main === module)
    main();
//# sourceMappingURL=cli.js.map