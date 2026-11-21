import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCall } from '../company/controller.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('extracted VSIX CLI initializes, reports status and executes company through packaged router path',async t=>{
  const temp=mkdtempSync(join(tmpdir(),'company-package-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const vsix=join(temp,'fuseway.vsix');
  await processCall(process.execPath,[join(repo,'extension/build.mjs'),vsix],{cwd:repo});
  const zip=readFileSync(vsix);let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50){
    const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString();const begin=offset+30+nameLength+extra;
    const target=join(temp,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,zip.subarray(begin,begin+size));offset=begin+size;
  }
  const extension=join(temp,'extension'),cli=join(extension,'bin/fuseway.mjs');
  assert.equal(JSON.parse(readFileSync(join(extension,'package.json'))).version,JSON.parse(readFileSync(join(repo,'extension/package.json'))).version);
  assert.ok(existsSync(join(extension,'icon.png')));
  assert.match(readFileSync(join(temp,'extension.vsixmanifest'),'utf8'),/<Icon>extension\/icon\.png<\/Icon>/);
  assert.ok(existsSync(join(extension,'company/controller.mjs')));assert.ok(existsSync(join(extension,'company/README.md')));
  const root=join(temp,'repo');mkdirSync(root);
  let sequence=0;
  const call=async(...args)=>{
    const output=join(temp,`output-${sequence++}.txt`);
    const preload='data:text/javascript;base64,'+Buffer.from(`import { appendFileSync } from 'node:fs'; console.log=(...args)=>appendFileSync(${JSON.stringify(output)},args.join(' ')+'\\n');`).toString('base64');
    try { await processCall(process.execPath,['--import',preload,cli,'company',...args],{cwd:root}); }
    catch (error) { error.capturedOutput = existsSync(output) ? readFileSync(output,'utf8') : ''; throw error; }
    return {stdout:readFileSync(output,'utf8')};
  };
  await call('init');assert.equal(JSON.parse((await call('status')).stdout).leader.id,'local-ceo');
  // Replace only the model boundary. The extracted CLI, module resolution, worktree
  // controller, protected verifier and subprocess acceptance all execute unchanged.
  writeFileSync(join(extension,'router.js'),`const fs=require('node:fs'),path=require('node:path');module.exports={run:async(backend,o)=>{if(o.allowEdits)fs.writeFileSync(path.join(o.cwd,'greeting.txt'),'Hello Fuseway!\\n');return {model:'packaged-observed',inTok:1,outTok:1,text:JSON.stringify({tasks:[{id:'build',worker:'local-builder',prompt:'build',dependsOn:[]}]})};}};`);
  const git=(...args)=>processCall('git',args,{cwd:root});
  await git('init','-q');await git('add','.');await git('-c','user.name=T','-c','user.email=t@t','commit','-qm','company');
  const run=JSON.parse((await call('run','.fuseway/example-mission.json')).stdout);
  assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.trials[0].calls.length,2);assert.equal(run.trials[0].calls[0].model,'packaged-observed');
  assert.equal(existsSync(join(root,'greeting.txt')),false);assert.ok(run.trials[0].checks[0].passed);
  writeFileSync(join(extension,'router.js'),`module.exports={run:async()=>({model:'packaged-observed',inTok:1,outTok:1,text:'invalid CEO plan'})};`);
  await assert.rejects(call('run','.fuseway/example-mission.json'), error => {
    assert.equal(error.code,1);
    assert.equal(JSON.parse(error.capturedOutput).status,'failed');
    return true;
  });
  writeFileSync(join(extension,'router.js'),`module.exports={run:async()=>{setTimeout(()=>process.kill(process.pid,'SIGINT'),10);return new Promise(()=>{});}};`);
  await assert.rejects(call('run','.fuseway/example-mission.json'), error => {
    assert.equal(error.code,130);
    assert.equal(JSON.parse(error.capturedOutput).status,'cancelled');
    return true;
  });
  assert.equal(existsSync(join(root,'.fuseway/company/lock')),false);
});
