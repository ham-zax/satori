import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { IndexingResourcePlanner } from '../indexing/resources';
import { assertParserFailureNoPublication } from './index-equivalence-harness';

const plan = Object.freeze({ ...new IndexingResourcePlanner({
    platform: () => 'darwin', readFile: () => { throw new Error('no proc'); },
    totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 2 * 1024 ** 3, cpuCount: () => 16,
}, () => ({ diagnostics: [] })).createPlan(), analysisProcessMaxFiles: 1 });

for (const fault of ['mid-file death', 'recycled startup failure', 'cancellation during recycling'] as const) {
    test(`${fault} leaves no publication or live parser processes`, { timeout: 30_000 }, async () => {
        await assertParserFailureNoPublication(plan, async (context, runtime, root, tempRoot) => {
            const preload = path.join(tempRoot, 'hold-parser.cjs');
            // Test-only job-boundary fault injection: the real parser runner
            // enters analyzeForIndexing(), announces its active file, then holds it until
            // the parent kills/cancels it. No sleeps or production diagnostics.
            fs.writeFileSync(preload, `
const Module=require('node:module'),load=Module._load;
Module._load=function(request,parent,...rest){
 const result=load.call(this,request,parent,...rest);
 if(request==='./service' && parent?.filename.includes('analysis-process-runner')){
  const create=result.createLanguageAnalysisService;
  return {...result,createLanguageAnalysisService:options=>({...create(options),analyzeForIndexing:async()=>{
   process.send({id:0,testStarted:true});await new Promise(()=>{});
  }})};
 }
 return result;
};
`);
            const original = childProcess.fork;
            const children: ChildProcess[] = [];
            let injected = false;
            childProcess.fork = ((...args: Parameters<typeof original>) => {
                if (!String(args[0]).includes('analysis-process-runner')) return original(...args);
                if (children.length === 1) args[2] = { ...args[2], execArgv: fault === 'recycled startup failure'
                    ? ['--invalid-parser-startup-flag'] : [...(args[2]?.execArgv ?? []), '--require', preload] };
                const child = original(...args);
                children.push(child);
                if (children.length === 2) {
                    if (fault === 'recycled startup failure') injected = true;
                    else child.on('message', message => {
                        if (!(message as { testStarted?: boolean }).testStarted) return;
                        injected = true;
                        if (fault === 'mid-file death') child.kill('SIGKILL');
                        else {
                            const active = runtime.getActiveMutation(root);
                            assert.ok(active);
                            assert.equal(runtime.requestCancellation(active.id, 'parser recycling fixture'), true);
                        }
                    });
                }
                return child;
            }) as typeof original;
            syncBuiltinESMExports();
            try {
                await assert.rejects(context.indexCodebase(root), fault === 'cancellation during recycling' ? /cancelled/ : /process exited/);
                assert.equal(injected, true);
                assert.equal(children.length, 2);
                assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
            } finally {
                childProcess.fork = original; syncBuiltinESMExports();
                await Promise.all(children.map(child => {
                    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
                    child.kill(); return new Promise<void>(resolve => child.once('close', () => resolve()));
                }));
            }
        });
    });
}
