import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLocalSession, localOfflineEnvironment } from './session.mjs';
import { normalizeHit, scoreQuery } from './score.mjs';
import { assertRuntimeDistFresh, importFreshDist } from './dist-freshness.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const reposDir = path.join(os.homedir(), '.cache/satori-eval-repos');
assertRuntimeDistFresh(root);
const { DEFAULT_SEARCH_FLAGS } = await importFreshDist(root, 'packages/mcp/dist/core/search-flags.js');
const { resolvePublicationNavigationRoot } = await importFreshDist(root, 'packages/core/dist/generation/publication-store.js');
const { vocabularyTokens } = await importFreshDist(root, 'packages/core/dist/vocabulary/extract.js');
const oracleFile = `${root}/evals/real-repo-quality/conceptual-cases.json`;
const cases = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
const ids = new Set(['r1', 'r8', 'r3_rewritten', 'fresh_r1', 'p3_rewritten', 'p5_rewritten', 'p8_rewritten', 'f2_rewritten', 'f4_rewritten', 'f5_rewritten', 'f10_rewritten']);
const runtimeFiles = ['packages/core/dist/vocabulary/service.js', 'packages/core/dist/vocabulary/extract.js', 'packages/core/dist/vocabulary/build.js', 'packages/core/dist/vocabulary/codec.js', 'packages/core/dist/vocabulary/storage.js', 'packages/core/dist/core/context.js', 'packages/core/dist/core/indexing-pipeline.js', 'packages/mcp/dist/core/handlers.js', 'packages/mcp/dist/core/search-flags.js', 'packages/mcp/dist/core/search-repository-vocabulary.js', 'packages/mcp/dist/core/search-request-coordinator.js', 'packages/mcp/dist/core/search-execution.js', 'packages/mcp/dist/core/search-rerank-query.js', 'packages/mcp/assets/lateon/rerank-request-contract-v1.json', 'packages/mcp/assets/lateon/runtime-profile-v6-d128.json'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeHash = () => hash(Buffer.concat(runtimeFiles.map(file => fs.readFileSync(path.join(root, file)))));
const startedRuntimeHash = runtimeHash();
const output = process.env.VOCABULARY_EVAL_OUTPUT ?? path.join(os.tmpdir(), 'satori-vocabulary-ablation.json');
// Each invocation owns fresh state; resuming can accidentally reuse an older publication.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-repo-vocabulary-eval-'));
const env = await localOfflineEnvironment();
const report = { diagnosticOnly: true, note: 'Same frozen 11 previously selected cases; no caller alt_terms; fresh index; vocabulary off/on in the same publication. Not a blind generalization benchmark.', stateRoot, oracleHash: hash(fs.readFileSync(oracleFile)), runtimeHash: startedRuntimeHash, runtime: Object.fromEntries(Object.entries(env).filter(([key]) => /MODEL|REVISION|PROFILE|ACTIVATION|DIMENSION|PROVIDER/.test(key))), loadAtStart: os.loadavg(), cpuCount: os.cpus().length, repos: [] };
const save = () => fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
let session;
try {
  session = await openLocalSession({ stateRoot, roots: [reposDir] });
  const status = async dir => (await session.call('manage_index', { action: 'status', path: dir })).json;
  for (const repo of cases.repos.filter(repo=>!process.env.VOCABULARY_EVAL_REPO || repo.name===process.env.VOCABULARY_EVAL_REPO)) {
    const dir = path.join(reposDir, `${repo.name}@${repo.commit}`);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
    if (!head.startsWith(repo.commit) || execFileSync('git', ['-C', dir, 'status', '--porcelain'], {encoding:'utf8'}).trim()) throw new Error(`Pinned repository mismatch: ${repo.name}`);
    process.stdout.write(`Indexing ${repo.name} into owned state ${stateRoot}\n`);
    const indexStarted = performance.now();
    const created = await session.call('manage_index', { action:'create', path:dir });
    if (created.isError) throw new Error(created.text);
    let ready;
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      ready = await status(dir);
      if (ready?.status === 'ok') break;
      if (ready?.status === 'error' || ['failed','blocked','cancelled'].includes(ready?.operation?.phase) || Date.now() > deadline) throw new Error(`Index failure ${repo.name}: ${JSON.stringify(ready)}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    const publicationId = ready.publication?.publicationId;
    if (!publicationId) throw new Error(`No publication identity: ${JSON.stringify(ready)}`);
    const record = { name:repo.name, head, publicationId, indexElapsedMs:performance.now()-indexStarted, queries:[] };
    const vocabularyFile=path.join(resolvePublicationNavigationRoot(dir,publicationId,stateRoot),'vocabulary.json');
    const vocabularyBytes=fs.readFileSync(vocabularyFile);
    const vocabulary=JSON.parse(vocabularyBytes);
    if (vocabulary.index.publicationId!==publicationId || vocabulary.payloadHash!==hash(JSON.stringify(vocabulary.index)) || vocabulary.index.budgetExceeded || vocabulary.index.documents.length===0) throw new Error(`Missing valid vocabulary: ${repo.name} ${JSON.stringify({publicationId,artifactId:vocabulary.index.publicationId,bytes:vocabularyBytes.length,checksumValid:vocabulary.payloadHash===hash(JSON.stringify(vocabulary.index)),budgetExceeded:vocabulary.index.budgetExceeded,documents:vocabulary.index.documents.length})}`);
    record.vocabulary={bytes:vocabularyBytes.length,sha256:hash(vocabularyBytes),documents:vocabulary.index.documents.length};
    let currentFile, lines, sourceHash, checked=0;
    for(const document of vocabulary.index.documents) {
      if(document.file!==currentFile) {
        currentFile=document.file;
        const source=fs.readFileSync(path.join(dir,currentFile),'utf8');
        sourceHash=hash(source);lines=source.split(/\r?\n/);
      }
      if(document.fileHash!==sourceHash) throw new Error(`Source witness mismatch: ${currentFile}`);
      for(const [word,kind,line] of document.terms) {
        if(kind===0) {
          if(!vocabularyTokens(lines[line-1]??'').includes(vocabulary.index.dictionary[word])) throw new Error(`Identifier provenance mismatch: ${currentFile}:${line}/${vocabulary.index.dictionary[word]}`);
          checked++;
        }
      }
    }
    record.vocabulary.identifierTermsChecked=checked;
    report.repos.push(record);
    process.stdout.write(`Indexed ${repo.name} in ${Math.round(record.indexElapsedMs/1000)}s; publication=${publicationId}\n`);
    for (const query of repo.queries) {
      const selected=ids.has(query.id);
      const pair = { id:query.id, query:query.query, selected, arms:[] };
      record.queries.push(pair);
      for (let repeat=0; repeat<(selected?3:1); repeat++) {
        for (const enabled of repeat % 2 === 0 ? [false,true] : [true,false]) {
          const args = { path:dir, query:query.query, limit:3, debugMode:'full', debugCandidateLimit:80, flags:{...DEFAULT_SEARCH_FLAGS,repo_vocab:enabled} };
          const started = performance.now();
          const response = await session.call('search_codebase', args);
          const elapsedMs = performance.now()-started;
          if (response.isError || response.json?.status !== 'ok') throw new Error(`Search ${query.id}: ${response.text.slice(0,800)}`);
          const hits = response.json.results.map((raw,index) => normalizeHit({rank:index+1,raw}, ()=>'unused'));
          const score = scoreQuery(query,hits);
          const expansion = response.json.hints?.debugSearch?.semanticExpansion;
          let arm = pair.arms.find(arm=>arm.repo_vocab===enabled);
          if (!arm) {
            arm = {repo_vocab:enabled,score,hits:hits.map(hit=>({rank:hit.rank,path:hit.path,symbol:hit.symbol})),expansion,timings:response.json.hints?.debugSearch?.timings,elapsedMs:[],samples:[]};
            pair.arms.push(arm);
          }
          arm.elapsedMs.push(elapsedMs);
          arm.samples.push({score,hits:hits.map(hit=>({rank:hit.rank,path:hit.path,symbol:hit.symbol}))});
        }
      }
      for (const arm of pair.arms) {
        arm.medianElapsedMs=median(arm.elapsedMs);
        arm.meanMrr=arm.samples.reduce((sum,sample)=>sum+(sample.score.strictRank?1/sample.score.strictRank:0),0)/arm.samples.length;
        arm.rankVaried=arm.samples.some(sample=>sample.score.strictRank!==arm.score.strictRank);
        arm.hitsVaried=arm.samples.some(sample=>JSON.stringify(sample.hits)!==JSON.stringify(arm.hits));
      }
      const off=pair.arms.find(arm=>!arm.repo_vocab), on=pair.arms.find(arm=>arm.repo_vocab);
      process.stdout.write(`${repo.name} ${query.id}: strict ${off.score.strictRank??'miss'} -> ${on.score.strictRank??'miss'}; terms=${JSON.stringify(on.expansion?.termsEmitted??[])}; ms=${off.medianElapsedMs.toFixed(1)} -> ${on.medianElapsedMs.toFixed(1)}\n`);
      if ((await status(dir))?.publication?.publicationId!==publicationId) throw new Error('Publication changed during comparison');
      save();
    }
  }
  if (runtimeHash()!==startedRuntimeHash) throw new Error('Compiled runtime changed during comparison');
  const allPairs=report.repos.flatMap(repo=>repo.queries);
  const pairs=allPairs.filter(pair=>pair.selected);
  const expectedCount=cases.repos.filter(repo=>!process.env.VOCABULARY_EVAL_REPO || repo.name===process.env.VOCABULARY_EVAL_REPO).flatMap(repo=>repo.queries).filter(query=>ids.has(query.id)).length;
  if (pairs.length!==expectedCount) throw new Error(`Expected ${expectedCount} selected cases, got ${pairs.length}`);
  report.summary=[false,true].map(enabled=>{
    const arms=pairs.map(pair=>pair.arms.find(arm=>arm.repo_vocab===enabled));
    return {repo_vocab:enabled,queries:arms.length,hit1:arms.filter(arm=>arm.score.strictRank===1).length,hit3:arms.filter(arm=>arm.score.strictRank!==null).length,hit3Min:arms.filter(arm=>arm.samples.every(sample=>sample.score.strictRank!==null)).length,hit3Max:arms.filter(arm=>arm.samples.some(sample=>sample.score.strictRank!==null)).length,mrr3:arms.reduce((sum,arm)=>sum+arm.meanMrr,0)/arms.length,medianQueryMs:median(arms.map(arm=>arm.medianElapsedMs)),varyingRanks:arms.filter(arm=>arm.rankVaried).length,varyingHits:arms.filter(arm=>arm.hitsVaried).length};
  });
  report.guardSummary=[false,true].map(enabled=>{
    const arms=allPairs.filter(pair=>!pair.selected).map(pair=>pair.arms.find(arm=>arm.repo_vocab===enabled));
    return {repo_vocab:enabled,queries:arms.length,hit1:arms.filter(arm=>arm.score.strictRank===1).length,hit3:arms.filter(arm=>arm.score.strictRank!==null).length,mrr3:arms.reduce((sum,arm)=>sum+(arm.score.strictRank?1/arm.score.strictRank:0),0)/arms.length};
  });
  report.loadAtEnd=os.loadavg();
  report.maxParentRssKiB=process.resourceUsage().maxRSS;
  save();
  process.stdout.write(`${JSON.stringify(report.summary)}\nResults: ${output}\n`);
} catch(error) { report.error=String(error.stack??error);save();throw error; }
finally {
  if (session) await session.close();
  // The model link points to user-owned data; recursive removal must never follow it.
  const models=path.join(stateRoot,'models');
  if (fs.lstatSync(models,{throwIfNoEntry:false})?.isSymbolicLink()) fs.unlinkSync(models);
  if (!report.error) fs.rmSync(stateRoot,{recursive:true,force:true});
}
