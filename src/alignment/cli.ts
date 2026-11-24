#!/usr/bin/env node
/**
 * dt-align --pt <pt.json|pt.xml> --dt <dt.json|dt.xml> --ontology <K.ont>
 *          --pt-interp <pt.interp> --dt-interp <dt.interp>
 *          [--mode strong|weak] [--syntactic] [--critical a,b] [--json]
 * dt-align --refines --ontology <new.ont> --pt-interp ... --dt-interp ...
 *          --old-ontology <old.ont> --old-pt-interp ... --old-dt-interp ...
 */
import * as fs from 'fs';
import { checkAlignment } from './checker';
import { DomainKnowledge, parseInterpretation, parseOntology } from './ontology';
import { checkKnowledgeRefinement } from './refinement';
import { TimedAutomaton, parseTA, parseUppaalXml } from './ta';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (n: string) => process.argv.includes(n);
const need = (n: string) => { const v = arg(n); if (!v) { console.error(`missing ${n}`); process.exit(2); } return v!; };

export function loadView(file: string): TimedAutomaton {
    const txt = fs.readFileSync(file, 'utf8');
    return file.endsWith('.xml') ? parseUppaalXml(txt) : parseTA(JSON.parse(txt));
}

export function loadKnowledge(ont: string, pti: string, dti: string): DomainKnowledge {
    return {
        ontology: parseOntology(fs.readFileSync(ont, 'utf8'), ont),
        pt: parseInterpretation(fs.readFileSync(pti, 'utf8')),
        dt: parseInterpretation(fs.readFileSync(dti, 'utf8')),
    };
}

function main() {
    if (flag('--refines')) {
        const r = checkKnowledgeRefinement(
            loadKnowledge(need('--ontology'), need('--pt-interp'), need('--dt-interp')),
            loadKnowledge(need('--old-ontology'), need('--old-pt-interp'), need('--old-dt-interp')));
        console.log(flag('--json') ? JSON.stringify(r, null, 2) : `Phi' refines Phi: ${r.holds}\n` + r.violations.map(v => ` (${v.condition}) ${v.item}: ${v.detail} ${v.countermodel ? JSON.stringify(v.countermodel) : ''}`).join('\n'));
        process.exit(r.holds ? 0 : 1);
    }
    const syntactic = flag('--syntactic');
    const phi = syntactic ? null : loadKnowledge(need('--ontology'), need('--pt-interp'), need('--dt-interp'));
    const res = checkAlignment(loadView(need('--pt')), loadView(need('--dt')), phi, {
        mode: (arg('--mode') as any) || 'strong', matching: syntactic ? 'syntactic' : 'semantic',
        critical: arg('--critical')?.split(',').filter(Boolean),
        maxTau: arg('--max-tau') ? parseInt(arg('--max-tau')!, 10) : undefined,
    });
    if (flag('--json')) console.log(JSON.stringify(res, null, 2));
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

if (require.main === module) main();
