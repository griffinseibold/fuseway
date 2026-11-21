import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateConfig, validateMission, validatePlan, fingerprint, readJson, idPattern } from './config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const finished = new Set(['completed','failed','cancelled']);
export function atomic(path, value) {
  mkdirSync(dirname(path), { recursive:true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value,null,2)+'\n', { flag:'wx' });
  renameSync(temp,path);
}
export function processCall(command, args, { cwd, signal, timeout = 30000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(command,args,{ cwd, signal, timeout, maxBuffer:1024*1024, encoding:'utf8', env:{...process.env, GIT_TERMINAL_PROMPT:'0'} },(error,stdout,stderr) => {
      if (error) fail(Object.assign(new Error(`${command}: ${stderr || error.message}`), {code:error.code,stdout,stderr}));
      else ok({stdout,stderr,code:0});
    });
  });
}
async function routerCall(profile, opts) {
  const location = existsSync(join(ROOT,'extension/router.js')) ? join(ROOT,'extension/router.js') : join(ROOT,'router.js');
  const { default:router } = await import(pathToFileURL(location).href);
  return router.run(profile.backend, { ...opts, claudeModel:profile.model, codexModel:profile.model, localModel:profile.model, grokModel:profile.model, codexEffort:profile.effort, localEffort:profile.effort });
}
function safeFile(root, rel) {
  const path = resolve(root,rel);
  if (relative(root,path).startsWith('..')) throw new Error('Protected verifier escapes repository');
  let current = root;
  for (const part of relative(root,path).split('/')) {
    current = join(current,part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Protected path has symlink: ${rel}`);
  }
  return path;
}
const statOrNull = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function restore(root, snapshot) {
  for (const [rel, content, mode] of snapshot) {
    // Remove symlinks or directories inserted by a worker, including ancestors.
    let current = root;
    const parts = rel.split('/');
    for (const part of parts.slice(0,-1)) {
      current = join(current,part);
      if (statOrNull(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) rmSync(current,{recursive:true,force:true});
      mkdirSync(current,{recursive:true});
    }
    const target = join(root,rel);
    if (statOrNull(target)) rmSync(target,{recursive:true,force:true});
    writeFileSync(target,content,{mode});
    chmodSync(target,mode);
  }
}
function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((ok, fail) => {
    const abort = () => fail(signal.reason || new Error('cancelled'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(ok,fail).finally(() => signal.removeEventListener('abort',abort));
  });
}
export class Company {
  constructor(root, { agent = routerCall, process = processCall, onProgress = () => {} } = {}) {
    this.root = resolve(root); this.dir = join(this.root,'.fuseway/company'); this.agent = agent; this.process = process; this.onProgress = onProgress;
  }
  config() {
    const path = join(this.root,'.fuseway/company.json');
    if (!existsSync(path)) throw new Error('Company is not initialized. Run fuseway company init, review its config, then commit it.');
    return validateConfig(readJson(path));
  }
  records() {
    const dir = join(this.dir,'runs');
    return existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.json')).map(x => readJson(join(dir,x))) : [];
  }
  leader(config) {
    const path = join(this.dir,'leader.json');
    const leader = existsSync(path) ? readJson(path) : {id:config.leader, provisional:true};
    const profile = config.roster.find(p => p.id === leader.id && p.enabled && p.roles.includes('ceo'));
    return profile && (!leader.profile || leader.profile === fingerprint(profile)) ? leader : {id:config.leader, provisional:true};
  }
  status() {
    const config = this.config();
    const locked = existsSync(join(this.dir,'lock'));
    const records = this.records().sort((a,b) => (b.createdAt || 0)-(a.createdAt || 0));
    const runs = records.slice(0,20).map(r => ({id:r.id,missionId:r.mission?.id,challenge:r.challenge,status:r.status,createdAt:r.createdAt,finishedAt:r.finishedAt,error:r.error,election:r.election,baselinePassed:r.baselinePassed,interrupted:!finished.has(r.status) && !locked,record:join(this.dir,'runs',`${r.id}.json`),trials:r.trials.map(t => ({candidate:t.candidate?.id,status:t.status,workspace:t.workspace,calls:t.calls?.length,inTok:t.inTok,outTok:t.outTok,usageIncomplete:t.usageIncomplete,ms:t.ms,error:t.error,models:t.calls?.map(c => ({profile:c.profile,model:c.model})),checks:t.checks?.map(c => ({argv:c.argv,passed:c.passed,ms:c.ms,error:c.error?.slice(0,300)}))}))}));
    return { leader:this.leader(config), roster:config.roster, controllerLocked:locked, controllerNote:locked ? 'A lock can outlive a crashed controller. Inspect lock/owner.json before manual recovery.' : undefined, totalRuns:records.length, runs, review:'Original checkout is unchanged. Review trial.workspace with git -C PATH diff and git -C PATH status. Copy reviewed changes manually; automatic apply is not supported.' };
  }
  stop(id) {
    if (!idPattern.test(id)) throw new Error('Use a run ID from company status');
    const path = join(this.dir,'runs',`${id}.json`);
    if (!existsSync(path)) throw new Error(`No run ${id}`);
    if (finished.has(readJson(path).status)) return `Run ${id} is already finished`;
    atomic(join(this.dir,'cancel',`${id}.json`),{requestedAt:Date.now()});
    return `Cancellation requested for ${id}`;
  }
  async run(missionFile, { challenge = false, signal } = {}) {
    // Parse owner input before creating any runtime files or invoking a backend.
    const config = this.config();
    const mission = validateMission(readJson(resolve(this.root,missionFile)));
    const protectedPaths = [...new Set([...mission.protectedPaths,'.fuseway/company.json',relative(this.root,resolve(this.root,missionFile))])];
    if (protectedPaths.some(p => p.startsWith('../') || p === '..')) throw new Error('Mission must live inside the repository');
    const snapshot = protectedPaths.map(p => { const path = safeFile(this.root,p); return [p,readFileSync(path),lstatSync(path).mode & 0o777]; });
    if (challenge && config.roster.filter(p => p.enabled && p.roles.includes('ceo')).length < 2) throw new Error('Enable at least two CEO profiles before a challenge');
    mkdirSync(this.dir,{recursive:true});
    const lock = join(this.dir,'lock');
    try { mkdirSync(lock); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Company controller is locked. Use status/stop. After a crashed controller exits, remove .fuseway/company/lock manually before retrying.');
      throw error;
    }
    const id = `run-${randomUUID()}`;
    const record = {id,mission,challenge,status:'queued',createdAt:Date.now(),trials:[]};
    let lastProgress;
    const save = () => {
      atomic(join(this.dir,'runs',`${id}.json`),record);
      const last = record.trials.at(-1);
      const progress = `${id} ${last?.candidate.id || ''} ${record.status}`.trim();
      if (progress !== lastProgress) { lastProgress = progress; try { this.onProgress(progress); } catch {} }
    };
    const cancel = new AbortController();
    const overall = AbortSignal.any([cancel.signal,AbortSignal.timeout(config.budget.challengeMs),...(signal ? [signal] : [])]);
    const poll = setInterval(() => { if (existsSync(join(this.dir,'cancel',`${id}.json`))) cancel.abort(new Error('Owner cancelled run')); },50);
    const proc = (cmd,args,cwd = this.root) => bounded(this.process(cmd,args,{cwd,signal:overall,timeout:config.budget.challengeMs}),overall);
    try {
      atomic(join(lock,'owner.json'),{id,pid:process.pid,startedAt:Date.now()}); save();
      const dirty = (await proc('git',['status','--porcelain','--untracked-files=all'])).stdout.trim();
      if (dirty) throw new Error('Commit or stash repository changes, including company config/mission/verifiers, before running');
      record.baseline = (await proc('git',['rev-parse','HEAD'])).stdout.trim();
      const leader = this.leader(config);
      const candidates = challenge ? config.roster.filter(p => p.enabled && p.roles.includes('ceo')) : [config.roster.find(p => p.id === leader.id)];
      // Every team receives the same immutable owner input and initial commit.
      record.comparison = fingerprint({mission,baseline:record.baseline,verifiers:snapshot.map(([p,b,mode]) => [p,b.toString('base64'),mode]),roster:config.roster,budget:config.budget});
      record.missionEvidence = fingerprint({goal:mission.goal,checks:mission.checks,verifiers:snapshot.filter(([p]) => mission.protectedPaths.includes(p)).map(([p,b,mode]) => [p,b.toString('base64'),mode])});
      record.policy = fingerprint({roster:config.roster,budget:config.budget,rule:'three-distinct-paired-wins-v1'});
      if (challenge) {
        const baselineWorkspace = join(this.dir,'worktrees',id,'_baseline');
        mkdirSync(dirname(baselineWorkspace),{recursive:true});
        await proc('git',['worktree','add','--detach',baselineWorkspace,record.baseline]);
        restore(baselineWorkspace,snapshot);
        record.baselineWorkspace = baselineWorkspace;
        record.baselineChecks = [];
        for (const argv of mission.checks) {
          overall.throwIfAborted();
          try {
            await bounded(this.process(argv[0],argv.slice(1),{cwd:baselineWorkspace,signal:overall,timeout:config.budget.checkMs}),overall);
            record.baselineChecks.push({argv,passed:true});
          } catch (error) {
            if (typeof error.code !== 'number') throw new Error(`Baseline verifier could not execute: ${error.message}`);
            record.baselineChecks.push({argv,passed:false,error:error.message});
          }
        }
        record.baselinePassed = record.baselineChecks.every(c => c.passed);
        save();
        if (record.baselinePassed) throw new Error('Acceptance already passes at baseline. Strengthen the mission verifier before a leadership challenge. No model calls were made.');
      }
      for (const candidate of candidates) {
        overall.throwIfAborted();
        const trial = {candidate,profile:fingerprint(candidate),workspace:join(this.dir,'worktrees',id,candidate.id),status:'queued',calls:[],checks:[],startedAt:Date.now(),usageIncomplete:false,inTok:0,outTok:0};
        record.trials.push(trial); save();
        const teamSignal = AbortSignal.any([overall,AbortSignal.timeout(config.budget.teamMs)]);
        const teamProcess = (cmd,args,cwd = this.root,timeout = config.budget.teamMs) => bounded(this.process(cmd,args,{cwd,signal:teamSignal,timeout}),teamSignal);
        try {
          mkdirSync(dirname(trial.workspace),{recursive:true});
          await teamProcess('git',['worktree','add','--detach',trial.workspace,record.baseline]);
          restore(trial.workspace,snapshot);
          trial.status = record.status = 'planning'; save();
          const call = async (profile,prompt,allowEdits,task) => {
            if (existsSync(join(this.dir,'cancel',`${id}.json`))) cancel.abort(new Error('Owner cancelled run'));
            teamSignal.throwIfAborted();
            if (trial.calls.length >= config.budget.calls) throw new Error('Team call budget exhausted');
            const attempt = {profile:profile.id,requestedProfile:structuredClone(profile),requestedModel:profile.model,requestedEffort:profile.effort,allowEdits,backend:profile.backend,task,startedAt:Date.now()};
            trial.calls.push(attempt); save();
            try {
              const result = await bounded(this.agent(profile,{prompt,cwd:trial.workspace,allowEdits,signal:teamSignal}),teamSignal);
              if (typeof result.text !== 'string' || result.text.length > 64000) throw new Error('Backend output exceeds 64000 characters');
              Object.assign(attempt,{model:result.model || 'unknown',effort:result.effort,requestedEffort:result.requestedEffort ?? profile.effort,inTok:result.inTok,outTok:result.outTok,costUsd:result.costUsd,usageIncomplete:!!result.usageIncomplete,ms:Date.now()-attempt.startedAt,text:result.text});
              if (result.usageIncomplete || !Number.isFinite(result.inTok) || !Number.isFinite(result.outTok) || result.inTok < 0 || result.outTok < 0) trial.usageIncomplete = true;
              else { trial.inTok += result.inTok; trial.outTok += result.outTok; }
              save();
              if (config.budget.observedTokens && (trial.usageIncomplete || trial.inTok + trial.outTok > config.budget.observedTokens)) throw new Error('Observed token stop threshold exceeded or usage unknown');
              teamSignal.throwIfAborted();
              return result.text;
            } catch (error) { attempt.error = error.message; if (!attempt.model) { attempt.model = error.result?.model || 'unknown'; attempt.usageIncomplete = true; trial.usageIncomplete = true; } attempt.ms = Date.now()-attempt.startedAt; save(); throw error; }
          };
          const workers = config.roster.filter(p => p.enabled && p.roles.some(r => r !== 'ceo'));
          const plan = validatePlan(await call(candidate,`You are the repository company CEO. Plan read-only. Delegate real work to the owner roster. Return ONLY JSON {"tasks":[{"id":"build","worker":"roster-id","prompt":"task","dependsOn":[]}]}. Tasks must be ordered by dependency. No more than ${config.budget.calls-1} tasks. Builder roles can write. Researcher/reviewer roles read only. You cannot change acceptance, budget or leader.\nMission: ${JSON.stringify(mission)}\nWorkers: ${JSON.stringify(workers)}\nBaseline: ${record.baseline}`,false,'plan'),config);
          trial.plan = plan; trial.status = record.status = 'working'; save();
          const outputs = {};
          for (const task of plan.tasks) {
            const worker = workers.find(p => p.id === task.worker);
            outputs[task.id] = await call(worker,`Owner mission: ${JSON.stringify(mission)}\nTask: ${task.prompt}\nDependency outputs: ${JSON.stringify(Object.fromEntries(task.dependsOn.map(d => [d,outputs[d]])))}\nDo not alter protected verifier files or company configuration.`,worker.roles.includes('builder'),task.id);
          }
          trial.status = record.status = 'verifying'; save();
          restore(trial.workspace,snapshot);
          for (const argv of mission.checks) {
            teamSignal.throwIfAborted();
            const check = {argv,startedAt:Date.now()}; trial.checks.push(check);
            try { Object.assign(check,await teamProcess(argv[0],argv.slice(1),trial.workspace,config.budget.checkMs),{passed:true}); }
            catch (error) { Object.assign(check,{passed:false,error:error.message,stdout:error.stdout,stderr:error.stderr,infrastructure:typeof error.code !== 'number'}); }
            check.ms = Date.now()-check.startedAt; save();
          }
          teamSignal.throwIfAborted();
          trial.status = trial.checks.every(c => c.passed) ? 'completed' : 'failed';
        } catch (error) { trial.status = cancel.signal.aborted || signal?.aborted ? 'cancelled' : 'failed'; trial.error = error.message; }
        finally { trial.ms = Date.now()-trial.startedAt; save(); }
      }
      overall.throwIfAborted();
      record.status = record.trials.some(t => t.status === 'completed') ? 'completed' : 'failed';
      if (challenge) record.election = this.elect(config,record,leader);
    } catch (error) { record.status = cancel.signal.aborted || signal?.aborted ? 'cancelled' : 'failed'; record.error = error.message; }
    finally { clearInterval(poll); record.finishedAt = Date.now(); save(); rmSync(lock,{recursive:true,force:true}); }
    return record;
  }
  elect(config, current, leader) {
    const records = [...this.records().filter(r => r.id !== current.id),current].filter(r => r.challenge && !r.baselinePassed && ['completed','failed'].includes(r.status) && !r.error && r.trials.length === current.trials.length && r.policy === current.policy);
    const known = t => t?.calls[0]?.model && t.calls[0].model !== 'unknown';
    const identity = t => fingerprint({profile:t.profile,model:t.calls[0]?.model,effort:t.calls[0]?.effort ?? null});
    const incumbent = current.trials.find(t => t.candidate.id === leader.id);
    if (leader.model && (leader.model !== incumbent?.calls[0]?.model || leader.profile !== incumbent?.profile || (leader.effort ?? null) !== (incumbent?.calls[0]?.effort ?? null))) {
      atomic(join(this.dir,'leader.json'),{id:leader.id,profile:incumbent?.profile,model:incumbent?.calls[0]?.model,effort:incumbent?.calls[0]?.effort,provisional:true});
      return {leader:leader.id,reason:'Incumbent model changed; evidence reset for this identity'};
    }
    if (!known(incumbent)) return {leader:leader.id,reason:'Incumbent identity unknown; no promotion'};
    // Record the first observed identity without claiming an election.
    if (!existsSync(join(this.dir,'leader.json'))) atomic(join(this.dir,'leader.json'),{...leader,profile:incumbent.profile,model:incumbent.calls[0].model,effort:incumbent.calls[0].effort});
    const latestById = new Map();
    const byTime = (a,b) => (a.createdAt || 0)-(b.createdAt || 0);
    for (const r of records.sort(byTime)) latestById.set(r.mission.id,r);
    const latest = new Map();
    for (const r of [...latestById.values()].sort(byTime)) latest.set(r.missionEvidence,r);
    const wins = {}, losses = {};
    for (const challenger of current.trials.filter(t => t.candidate.id !== leader.id && known(t))) {
      const won = new Set(), lost = new Set();
      for (const r of latest.values()) {
        const a = r.trials.find(t => t.candidate.id === leader.id), b = r.trials.find(t => t.candidate.id === challenger.candidate.id);
        if (a?.checks?.some(c => c.infrastructure) || b?.checks?.some(c => c.infrastructure)) continue;
        if (!known(a) || !known(b) || identity(a) !== identity(incumbent) || identity(b) !== identity(challenger)) continue;
        const aPassed = a.status === 'completed', bPassed = b.status === 'completed';
        const measured = !a.usageIncomplete && !b.usageIncomplete;
        if (bPassed && (!aPassed || measured && b.calls.length < a.calls.length)) won.add(r.mission.id);
        if (aPassed && (!bPassed || measured && a.calls.length < b.calls.length)) lost.add(r.mission.id);
      }
      wins[challenger.candidate.id] = won.size;
      losses[challenger.candidate.id] = lost.size;
    }
    const eligible = Object.entries(wins).filter(([id,n]) => n >= 3 && n > losses[id]).sort((a,b) => b[1]-a[1]);
    if (!eligible.length || eligible[0][1] === eligible[1]?.[1]) return {leader:leader.id,wins,losses,reason:'Need three distinct paired mission wins and more wins than losses; ties retain incumbent'};
    const winner = current.trials.find(t => t.candidate.id === eligible[0][0]);
    const elected = {id:winner.candidate.id,profile:winner.profile,model:winner.calls[0].model,effort:winner.calls[0].effort,provisional:false,electedAt:Date.now(),run:current.id};
    atomic(join(this.dir,'leader.json'),elected);
    return {leader:elected.id,wins,losses,reason:'Three distinct paired mission wins'};
  }
}
