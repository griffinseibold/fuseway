import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Company, processCall, atomic } from '../company/controller.mjs';
import { init, readJson, validateConfig, validateMission, validatePlan, fingerprint } from '../company/config.mjs';
import { command } from '../company/cli.mjs';

async function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(),'company-test-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  init(root);
  const config = readJson(join(root,'.fuseway/company.json'));
  config.budget = {calls:5,teamMs:5000,challengeMs:20000,checkMs:2000};
  config.roster.push({id:'challenger',backend:'codex',model:'exact-model',effort:'high',enabled:true,roles:['ceo']});
  Object.assign(config,extra);
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));
  const mission = {id:'one',goal:'Build artifact then review',checks:[[process.execPath,'verify.mjs']],protectedPaths:['verify.mjs']};
  writeFileSync(join(root,'mission.json'),JSON.stringify(mission));
  writeFileSync(join(root,'verify.mjs'),"import { readFileSync } from 'node:fs'; if(readFileSync('artifact.txt','utf8') !== 'done') process.exit(1);\n");
  const git = (...args) => processCall('git',args,{cwd:root});
  await git('init','-q'); await git('add','.'); await git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline');
  return {root,config,mission,git};
}
const result = (text,model='observed-model') => ({text,model,inTok:12,outTok:8});
const plan = JSON.stringify({tasks:[{id:'build',worker:'local-builder',prompt:'create artifact',dependsOn:[]},{id:'review',worker:'local-reviewer',prompt:'review artifact',dependsOn:['build']}]});
test('owner configuration versions and effort capabilities are explicit',async t=>{
  const {config}=await fixture(t);
  assert.equal(config.version,1);
  assert.throws(()=>validateConfig({...config,version:2}),/version: 1/);
  const unsupported=structuredClone(config);
  unsupported.roster.push({id:'claude-effort',backend:'claude',enabled:false,roles:['ceo'],effort:'high'});
  assert.throws(()=>validateConfig(unsupported),/only on local\/Codex/);
});
test('attempts preserve owner role permissions and requested versus observed model settings',async t=>{
  const {root,config,git}=await fixture(t);
  config.roster[0].effort='high';
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));
  await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','CEO effort');
  const work=agent([]);
  const run=await new Company(root,{agent:async(profile,opts)=>({...await work(profile,opts),effort:'low',requestedEffort:profile.effort})}).run('mission.json');
  assert.equal(run.status,'completed');
  const ceo=run.trials[0].calls[0];
  assert.deepEqual(ceo.requestedProfile,config.roster[0]);
  assert.equal(ceo.allowEdits,false);
  assert.equal(ceo.requestedEffort,'high');
  assert.equal(ceo.effort,'low');
  assert.equal(run.trials[0].calls[1].allowEdits,true);
});
function agent(calls, mutate = () => {}) {
  return async (profile, opts) => {
    calls.push({profile,...opts});
    if (profile.roles.includes('ceo')) return result(plan,`${profile.id}-observed`);
    if (profile.roles.includes('builder')) { writeFileSync(join(opts.cwd,'artifact.txt'),'done'); mutate(opts); return result('artifact ready','local-exact'); }
    assert.match(opts.prompt,/artifact ready/);
    assert.equal(readFileSync(join(opts.cwd,'artifact.txt'),'utf8'),'done');
    return result('reviewed','review-model');
  };
}
test('init is idempotent, config and mission are reviewable, runtime is ignored', async t => {
  const {root,git} = await fixture(t);
  const before = readFileSync(join(root,'.fuseway/company.json'),'utf8'); init(root);
  assert.equal(readFileSync(join(root,'.fuseway/company.json'),'utf8'),before);
  validateMission(readJson(join(root,'.fuseway/example-mission.json')));
  assert.equal((await git('status','--porcelain')).stdout,'');
  await assert.rejects(command(root,'apply'),/Automatic apply is not supported/);
});
test('local CEO delegates dependent workers, verifies artifact, persists and isolates checkout', async t => {
  const {root,git} = await fixture(t); const calls = [];
  const company = new Company(root,{agent:agent(calls)});
  const run = await company.run('mission.json');
  assert.equal(run.status,'completed',JSON.stringify(run));
  assert.deepEqual(calls.map(c => c.allowEdits),[false,true,false]);
  assert.equal(calls[0].profile.backend,'local');
  assert.equal(run.trials[0].calls[0].model,'local-ceo-observed');
  assert.equal(run.trials[0].calls[1].model,'local-exact');
  assert.equal(run.trials[0].inTok,36);
  assert.ok(run.trials[0].checks[0].passed);
  assert.equal(existsSync(join(root,'artifact.txt')),false);
  assert.equal((await git('status','--porcelain')).stdout,'');
  assert.equal(new Company(root).status().runs[0].status,'completed');
});
test('restores deleted/tampered verifier and owner config before external grading', async t => {
  const {root} = await fixture(t);
  const tamper = agent([],opts => {
    writeFileSync(join(opts.cwd,'artifact.txt'),'wrong');
    writeFileSync(join(opts.cwd,'verify.mjs'),'process.exit(0)');
    writeFileSync(join(opts.cwd,'.fuseway/company.json'),'{}');
  });
  const company = new Company(root,{agent:(p,o)=>p.roles.includes('reviewer') ? result('reviewed') : tamper(p,o)});
  const run = await company.run('mission.json');
  assert.equal(run.status,'failed');
  assert.equal(run.trials[0].checks[0].passed,false);
  assert.match(readFileSync(join(run.trials[0].workspace,'verify.mjs'),'utf8'),/artifact.txt/);
  assert.equal(readJson(join(run.trials[0].workspace,'.fuseway/company.json')).leader,'local-ceo');
});
test('invalid graphs and malicious tool flags cannot bypass roster roles or spend calls', async t => {
  const {root,config} = await fixture(t);
  for (const tasks of [[],[{id:'a',worker:'not-roster',prompt:'x',dependsOn:[]}],[{id:'a',worker:'local-builder',prompt:'x',dependsOn:['b']}]]) {
    assert.throws(() => validatePlan(JSON.stringify({tasks}),config));
  }
  const calls=[];
  const run = await new Company(root,{agent:async (p,o) => {calls.push(o); return result('{"tasks":[{"id":"evil","worker":"local-reviewer","prompt":"inspect","dependsOn":[],"allowEdits":true}]}');}}).run('mission.json');
  assert.equal(calls.length,2); assert.ok(calls.every(c => !c.allowEdits)); assert.equal(run.status,'failed');
  const invalid = await new Company(root,{agent:async () => result('not JSON')}).run('mission.json');
  assert.equal(invalid.trials[0].calls.length,1); assert.match(invalid.trials[0].error,/JSON/);
});
test('validation and dirty baseline fail before model calls', async t => {
  const {root} = await fixture(t); let calls=0;
  const company = new Company(root,{agent:async () => {calls++; return result(plan);}});
  writeFileSync(join(root,'mission.json'),JSON.stringify({id:'bad',goal:'x',checks:[],protectedPaths:['verify.mjs']}));
  await assert.rejects(company.run('mission.json'),/checks/);
  assert.equal(existsSync(company.dir),false);
  writeFileSync(join(root,'mission.json'),JSON.stringify({id:'good',goal:'x',checks:[[process.execPath,'verify.mjs']],protectedPaths:['verify.mjs']}));
  const run = await company.run('mission.json');
  assert.equal(run.status,'failed'); assert.match(run.error,/Commit or stash/); assert.equal(calls,0);
});
test('single controller lock, status and scoped stop work during execution', async t => {
  const {root} = await fixture(t); let enter;
  const entered = new Promise(r => { enter=r; });
  const company = new Company(root,{agent:async (p,{signal}) => { enter(); return new Promise((ok,no) => signal.addEventListener('abort',()=>no(new Error('aborted')),{once:true})); }});
  const running = company.run('mission.json'); await entered;
  const status = new Company(root).status(); const id = status.runs[0].id;
  assert.ok(status.controllerLocked); assert.equal(status.runs[0].status,'planning');
  await assert.rejects(new Company(root).run('mission.json'),/locked/);
  assert.match(new Company(root).stop(id),/Cancellation requested/);
  const run = await running;
  assert.equal(run.status,'cancelled'); assert.equal(run.trials[0].calls.length,1);
  assert.equal(new Company(root).status().controllerLocked,false);
  atomic(join(company.dir,'runs','interrupted.json'),{id:'interrupted',status:'working',trials:[]});
  assert.ok(new Company(root).status().runs.find(r=>r.id==='interrupted').interrupted);
});
test('team and observed-token budgets stop subsequent calls and retain attempts', async t => {
  const {root,config,git} = await fixture(t);
  config.budget.teamMs=80;
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config)); await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','budget');
  const run = await new Company(root,{agent:async () => new Promise(()=>{})}).run('mission.json');
  assert.equal(run.status,'failed'); assert.equal(run.trials[0].calls.length,1);
  config.budget.teamMs=5000;config.budget.observedTokens=1;
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','tokens');
  const tokenRun = await new Company(root,{agent:async()=>result(plan)}).run('mission.json');
  assert.equal(tokenRun.trials[0].calls.length,1);assert.match(tokenRun.trials[0].error,/token/);
});
test('challenge uses equal isolated baselines and exact requested/observed profiles', async t => {
  const {root} = await fixture(t); const calls=[];
  const run = await new Company(root,{agent:agent(calls)}).run('mission.json',{challenge:true});
  assert.equal(run.status,'completed',JSON.stringify(run)); assert.equal(run.trials.length,2);
  assert.notEqual(run.trials[0].workspace,run.trials[1].workspace);
  assert.equal(run.baselineChecks[0].passed,false);
  for (const trial of run.trials) assert.equal((await processCall('git',['rev-parse','HEAD'],{cwd:trial.workspace})).stdout.trim(),run.baseline);
  const challenger = calls.find(c=>c.profile.id==='challenger');
  assert.equal(challenger.profile.model,'exact-model'); assert.equal(challenger.profile.effort,'high');
  assert.equal(run.trials[1].calls[0].model,'challenger-observed');
  assert.equal(run.election.leader,'local-ceo');
});
test('already-passing baseline cannot spend model quota or create promotion evidence', async t => {
  const {root,git} = await fixture(t);writeFileSync(join(root,'artifact.txt'),'done');await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','already done');
  let calls=0;
  const run=await new Company(root,{agent:async()=>{calls++;return result(plan);}}).run('mission.json',{challenge:true});
  assert.equal(run.status,'failed');assert.equal(run.baselinePassed,true);assert.equal(calls,0);assert.match(run.error,/already passes/);
});
test('elections require three distinct paired missions, known identities, matching policy and no replays', async t => {
  const {root,config} = await fixture(t);const company=new Company(root);
  const trial=(id,n,extra={})=>({candidate:config.roster.find(p=>p.id===id),profile:fingerprint(config.roster.find(p=>p.id===id)),status:'completed',calls:Array.from({length:n},()=>({model:`${id}-actual`})),usageIncomplete:false,checks:[{passed:true}],...extra});
  const record=(id,mission,extra={})=>({id,mission:{id:mission},missionEvidence:mission,challenge:true,status:'completed',policy:'same',trials:[trial('local-ceo',3),trial('challenger',2)],...extra});
  const leader={id:'local-ceo',provisional:true};
  atomic(join(company.dir,'runs','a.json'),record('a','one'));
  atomic(join(company.dir,'runs','b.json'),record('b','one'));
  assert.equal(company.elect(config,record('c','two'),leader).leader,'local-ceo');
  atomic(join(company.dir,'runs','c.json'),record('c','two'));
  assert.equal(company.elect(config,record('d','three',{policy:'changed'}),leader).leader,'local-ceo');
  const unknown=record('d','three');unknown.trials[1].calls[0].model='unknown';
  assert.equal(company.elect(config,unknown,leader).leader,'local-ceo');
  const incomplete=record('d','three');incomplete.trials[1].usageIncomplete=true;
  assert.equal(company.elect(config,incomplete,leader).leader,'local-ceo');
  const changed=record('d','three');changed.trials[1].calls[0].model='new-model';
  assert.equal(company.elect(config,changed,leader).leader,'local-ceo');
  const changedEffort=record('d','three');changedEffort.trials[1].calls[0].effort='low';
  assert.equal(company.elect(config,changedEffort,leader).leader,'local-ceo');
  assert.equal(company.elect(config,record('d','three'),leader).leader,'challenger');
  assert.equal(company.leader(config).provisional,false);
});
test('finite config limits and mission traversal are rejected',()=>{
  assert.throws(()=>validateConfig({roster:[]}));
  assert.throws(()=>validateMission({id:'x',goal:'x',checks:[['node']],protectedPaths:['../outside']}));
  assert.throws(()=>validateMission({id:'x',goal:'x',checks:[['node']],protectedPaths:['.fuseway/company/leader.json']}));
});
test('dangling verifier symlinks are removed without writing outside trial; executable modes survive',async t=>{
  const {root,git}=await fixture(t);
  chmodSync(join(root,'verify.mjs'),0o755);await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','executable verifier');
  const outside=mkdtempSync(join(tmpdir(),'company-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  const target=join(outside,'must-not-exist');
  const tamper=agent([],opts=>{rmSync(join(opts.cwd,'verify.mjs'));symlinkSync(target,join(opts.cwd,'verify.mjs'));});
  const run=await new Company(root,{agent:tamper}).run('mission.json');
  assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(existsSync(target),false);
  assert.equal(statSync(join(run.trials[0].workspace,'verify.mjs')).mode & 0o777,0o755);
});
test('challenge rejects one CEO and verifier infrastructure errors before model calls',async t=>{
  const {root,config,git}=await fixture(t);let calls=0;
  const company=new Company(root,{agent:async()=>{calls++;return result(plan);}});
  config.roster.find(p=>p.id==='challenger').enabled=false;
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));
  await assert.rejects(company.run('mission.json',{challenge:true}),/two CEO/);
  config.roster.find(p=>p.id==='challenger').enabled=true;
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));
  const mission=readJson(join(root,'mission.json'));mission.checks=[['does-not-exist-fuseway-verifier']];
  writeFileSync(join(root,'mission.json'),JSON.stringify(mission));await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','bad check');
  const run=await company.run('mission.json',{challenge:true});
  assert.equal(run.status,'failed');assert.match(run.error,/could not execute/);assert.equal(calls,0);
});
test('process launch errors are never passing verification and call errors retain unknown usage',async t=>{
  const {root}=await fixture(t);
  const run=await new Company(root,{agent:async()=>{throw new Error('offline');}}).run('mission.json');
  assert.equal(run.status,'failed');assert.equal(run.trials[0].usageIncomplete,true);
  assert.equal(run.trials[0].calls[0].model,'unknown');
  await assert.rejects(processCall('missing-fuseway-command',[]),/missing-fuseway-command/);
});
test('latest comparable pairs replace replays regardless of filenames, renamed content and losses prevent promotion',async t=>{
  const {root,config}=await fixture(t);const company=new Company(root);
  const trial=(id,n)=>({candidate:config.roster.find(p=>p.id===id),profile:fingerprint(config.roster.find(p=>p.id===id)),status:'completed',calls:Array.from({length:n},()=>({model:`${id}-actual`})),usageIncomplete:false,checks:[{passed:true}]});
  const pair=(id,mission,createdAt,win=true,content=mission)=>({id,createdAt,mission:{id:mission},missionEvidence:content,challenge:true,status:'completed',policy:'same',trials:[trial('local-ceo',win?3:2),trial('challenger',win?2:3)]});
  const put=r=>atomic(join(company.dir,'runs',`${r.id}.json`),r);
  const leader={id:'local-ceo',provisional:true};
  put(pair('z-old','one',1));put(pair('b-two','two',2));
  const renamed=pair('c-three','three',3,true,'two');
  assert.equal(company.elect(config,renamed,leader).leader,'local-ceo');
  // UUID/file ordering differs from event ordering: latest loss replaces old win.
  put(pair('a-latest','one',5,false));
  assert.equal(company.elect(config,pair('d-three','three',6),leader).wins.challenger,2);
  put(pair('e-three','three',6));
  put(pair('f-loss-two','loss-two',7,false));put(pair('g-loss-three','loss-three',8,false));
  const tied=company.elect(config,pair('h-four','four',9),leader);
  assert.equal(tied.wins.challenger,3);assert.equal(tied.losses.challenger,3);assert.equal(tied.leader,'local-ceo');
  const unknown=pair('i-four','four',10);unknown.trials[1].calls[0].model='unknown';
  assert.equal(company.elect(config,unknown,leader).leader,'local-ceo');
});
test('verifier deadline cannot turn a hung acceptance process into success',async t=>{
  const {root,config,git}=await fixture(t);config.budget.checkMs=80;
  writeFileSync(join(root,'.fuseway/company.json'),JSON.stringify(config));
  writeFileSync(join(root,'verify.mjs'),'setInterval(()=>{},1000);');
  await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','slow verifier');
  const run=await new Company(root,{agent:agent([])}).run('mission.json');
  assert.equal(run.status,'failed');assert.equal(run.trials[0].checks[0].passed,false);
});
test('three actual distinct paired challenges elect efficient CEO across clean baselines; progress is reviewable',async t=>{
  const {root,git,mission}=await fixture(t);const progress=[];
  const company=new Company(root,{onProgress:message=>progress.push(message),agent:async(profile,opts)=>{
    if(profile.roles.includes('ceo')) return result(profile.id==='local-ceo' ? plan : JSON.stringify({tasks:[{id:'build',worker:'local-builder',prompt:'build',dependsOn:[]}]}),`${profile.id}-actual`);
    if(profile.roles.includes('builder')) {writeFileSync(join(opts.cwd,'artifact.txt'),'done');return result('artifact ready','local-worker');}
    return result('reviewed','local-reviewer');
  }});
  let run;
  for(let i=1;i<=3;i++){
    mission.id=`mission-${i}`;mission.goal=`Build artifact and demonstrate owner task ${i}`;
    writeFileSync(join(root,'mission.json'),JSON.stringify(mission));await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm',`mission ${i}`);
    run=await company.run('mission.json',{challenge:true});assert.equal(run.status,'completed',JSON.stringify(run));
    assert.equal(run.election.leader,i<3?'local-ceo':'challenger');
  }
  assert.ok(progress.some(p=>p.includes(run.id)&&p.includes('planning')));assert.ok(progress.some(p=>p.includes('working')));assert.ok(progress.some(p=>p.includes('verifying')));
  const status=company.status();assert.equal(status.leader.id,'challenger');assert.equal(status.leader.provisional,false);
  assert.equal(status.totalRuns,3);assert.ok(status.runs.every(r=>r.record&&r.trials.every(t=>typeof t.calls==='number')));
  assert.equal(JSON.stringify(status).includes('artifact ready'),false);
});
