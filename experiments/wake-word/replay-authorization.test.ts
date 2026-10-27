import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sha } from './benchmark-contract.js';
import { runtimeCommit,artifactSha256 } from './native-benchmark.js';
import { digest,retentionMs } from './calibration-contract.js';
import { createReplayAuthorization,validateReplayAuthorization,checkedReplayLock,cleanReplayTiming,historicalTimingMode } from './replay-authorization.js';
import { saveReplayAuthorization,compareCalibrationMatrices } from './calibration-session.js';
const now=Date.parse('2026-10-27T12:00:00.000Z');
function fixture(){
  const lock={schema:1,kind:'NATIVE_LIVE',version:'2.0.0',commit:runtimeCommit,artifactSha256,
    sourceSha256:sha('old'),executableSha256:sha('oldexe'),calibrationSourceSha256:sha('oldcal'),diagnosticSourceSha256:sha('diagnostic'),referenceSourceSha256:sha('reference'),coreSourceSha256:sha('core')};
  const capture=JSON.stringify(lock),replay=JSON.stringify({...lock,sourceSha256:sha('new'),calibrationSourceSha256:sha('newcal'),executableSha256:sha('newexe')});
  const manifest={trialId:'a'.repeat(32),createdAtUtc:new Date(now-1000).toISOString(),expiresAtUtc:new Date(now-1000+retentionMs).toISOString(),
    samples:1600,pcmSha256:sha('synthetic'),reportSha256:sha('report'),annotationSha256:sha('annotations'),lockSha256:sha(capture),
    modelHashes:Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(k=>[k,sha(k)]))};
  const annex=createReplayAuthorization(manifest,capture,replay,sha('newexe'),'ACOUSTIC_BACKPRESSURE',now);
  const check=(a:any=annex,m:any=manifest,r=replay,exe=sha('newexe'),mode:any='ACOUSTIC_BACKPRESSURE',time=now)=>validateReplayAuthorization(a,annex.integritySha256,m,r,exe,mode,time);
  return {manifest,capture,replay,annex,check};
}
test('explicit exact dataset/runtime/mode annex validates without changing original data and never extends retention',()=>{
  const {manifest,annex,check}=fixture(),original=JSON.stringify(manifest);
  assert.equal(check().authorizationSha256,annex.integritySha256);assert.equal(JSON.stringify(manifest),original);
  assert.equal(annex.expiresAtUtc,manifest.expiresAtUtc);assert.equal(annex.recognition.length,3);
  assert.deepEqual(annex.recognition.map(r=>r.threshold),[.15,.1,.05]);
  assert.throws(()=>check(annex,manifest,undefined,undefined,undefined,Date.parse(manifest.expiresAtUtc)),{message:'CAL_RETENTION_EXPIRED'});
  assert.throws(()=>check(annex,{...manifest,expiresAtUtc:new Date(now+retentionMs).toISOString()}));
  assert.throws(()=>check({...annex,createdAtUtc:new Date(now+1).toISOString()}));
});
test('every nested hash is bound to the externally pinned annex digest, even if its self digest is recomputed',()=>{
  const {annex,check}=fixture();let count=0;
  function walk(value:any,path:string[]=[]){for(const [k,v] of Object.entries(value)){
    if(v&&typeof v==='object')walk(v,[...path,k]);
    else if(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)){
      const changed:any=structuredClone(annex);let target=changed;for(const part of path)target=target[part];target[k]=sha('altered');
      if(k!=='integritySha256'){const {integritySha256,...body}=changed;changed.integritySha256=digest(body);}assert.throws(()=>check(changed));count++;
    }
  }}walk(annex);assert.ok(count>=16);
});
test('wrong runtime, mode, models, dataset, original lock, incomplete/extra fields and configuration are rejected',()=>{
  const {manifest,capture,replay,annex,check}=fixture();
  assert.throws(()=>check(annex,manifest,replay,sha('unauthorized')));
  assert.throws(()=>check(annex,manifest,replay,undefined,'STRICT_REALTIME'));
  assert.throws(()=>check(annex,{...manifest,trialId:'b'.repeat(32)}));
  assert.throws(()=>check({...annex,pcm:[.1]}));assert.throws(()=>check({}));
  for(const key of Object.keys(annex)){const missing:any={...annex};delete missing[key];assert.throws(()=>check(missing));}
  const config=structuredClone(annex);config.recognition[0]!.configuration.score=2;assert.throws(()=>check(config));
  assert.throws(()=>createReplayAuthorization(manifest,capture,replay,sha('newexe'),'*' as any,now));
  const bad=JSON.parse(replay);bad.coreSourceSha256=sha('changed transport');
  assert.throws(()=>createReplayAuthorization(manifest,capture,JSON.stringify(bad),sha('newexe'),'ACOUSTIC_BACKPRESSURE',now));
  assert.throws(()=>checkedReplayLock(JSON.stringify({...bad,privatePath:'secret'})));
  assert.doesNotMatch(JSON.stringify(annex),/commandLine|deviceId|transcript|audioSamples|pcmData/);
});
test('authorization is exclusive create: duplicates cannot replace an existing manual authorization',async()=>{
  await mkdir('.local',{recursive:true});const dir=await mkdtemp('.local/auth-fixture-'),path=join(dir,'authorization.json');
  try{const {annex}=fixture();await saveReplayAuthorization(path,annex);const first=await readFile(path);
    await assert.rejects(saveReplayAuthorization(path,{...annex,consent:'replacement'}),{message:'CAL_AUTHORIZATION_EXISTS'});
    assert.deepEqual(await readFile(path),first);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('timing policy defaults only historical results to strict; metrics are closed, finite, bounded and no Live claim',()=>{
  assert.equal(historicalTimingMode(undefined),'STRICT_REALTIME');
  assert.equal(cleanReplayTiming(undefined,'STRICT_REALTIME',true).metricsAvailable,false);
  assert.throws(()=>cleanReplayTiming(undefined,'ACOUSTIC_BACKPRESSURE',true));
  const timing={timingMode:'ACOUSTIC_BACKPRESSURE',waitCount:2,capacityWaitWallMs:502,maxCapacityWaitWallMs:350,totalWallMs:3000,cancelled:false};
  assert.equal(cleanReplayTiming(timing,'ACOUSTIC_BACKPRESSURE').waitCount,2);
  for(const bad of [{...timing,waitCount:0},{...timing,totalWallMs:400},{...timing,maxCapacityWaitWallMs:600},{...timing,capacityWaitWallMs:NaN},{...timing,pcm:[1]},{...timing,waitCount:2000}])assert.throws(()=>cleanReplayTiming(bad,'ACOUSTIC_BACKPRESSURE'));
  assert.throws(()=>cleanReplayTiming(timing,'STRICT_REALTIME'));
});
function matrix(mode?:string,runtime=sha('runtime')){
  const rows=['POSITIVE','SILENCE','SIMILAR'].flatMap(kind=>[.15,.1,.05].map(threshold=>({kind,threshold,sessionId:'a'.repeat(32),pcmSha256:sha(kind),samples:960000,annotationSha256:sha(kind+'annotations'),
    recognitionSignature:sha(kind+threshold),rawHits:0,detections:0,suppressedHits:0,associatedPronunciations:kind==='POSITIVE'?0:null,omissions:kind==='POSITIVE'?20:null,duplicates:0,falsePositives:0,
    ...(mode?{timingMode:mode,replayProvenance:{captureLockSha256:sha('capture'),replayLockSha256:runtime,executableSha256:sha('exe'),authorizationSha256:sha(kind+'auth'),timingMode:mode}}:{})})));
  return {schema:1,state:'NINE_EXPERIMENTAL_EVALUATIONS_COMPLETE',runId:'1'.repeat(32),referenceThreshold:.15,modelIdentity:sha('models'),rows,...(mode?{timingMode:mode}:{})};
}
const signed=(body:any)=>({...body,integritySha256:digest(body)});
test('matrices reject cross-policy or cross-runtime equivalence and retain historical strict comparisons',()=>{
  const a=matrix('ACOUSTIC_BACKPRESSURE'),b={...matrix('ACOUSTIC_BACKPRESSURE'),runId:'2'.repeat(32)};
  assert.equal(compareCalibrationMatrices(signed(a),signed(b)).timingMode,'ACOUSTIC_BACKPRESSURE');
  for(const other of [matrix('STRICT_REALTIME'),matrix()])assert.throws(()=>compareCalibrationMatrices(signed(a),signed({...other,runId:b.runId})),{message:'CAL_TIMING_MODE_MISMATCH'});
  assert.throws(()=>compareCalibrationMatrices(signed(a),signed({...matrix('ACOUSTIC_BACKPRESSURE',sha('other')),runId:b.runId})),{message:'CAL_IDENTITY_MISMATCH'});
  assert.equal(compareCalibrationMatrices(signed(matrix()),signed({...matrix(),runId:b.runId})).timingMode,'STRICT_REALTIME');
  assert.throws(()=>compareCalibrationMatrices(signed(matrix()),signed({...matrix('STRICT_REALTIME'),runId:b.runId})),{message:'CAL_IDENTITY_MISMATCH'});
});
test('real queue capacity gate preserves synthetic PCM bits/order/tail under 120/350/502/1000 ms stalls, cancellation, timeout and errors',async(t)=>{
  if(process.platform!=='linux'){t.skip('Portable Linux compiler; MSVC acceptance separate');return;}
  const dir=await mkdtemp(join(tmpdir(),'replay-gate-'));
  try{const exe=join(dir,'gate');await promisify(execFile)('g++',['-std=c++17','-O2','-Wall','-Wextra','-Werror','experiments/wake-word/replay-backpressure.test.cc','-o',exe],{timeout:30000});
    const result=await promisify(execFile)(exe,{timeout:10000});assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('strict runtime changes require their own exact authorization; captured lock snapshots and all configuration fields are bound',()=>{
  const {manifest,capture,replay,annex,check}=fixture();
  const strict=createReplayAuthorization(manifest,capture,replay,sha('newexe'),'STRICT_REALTIME',now);
  assert.equal(validateReplayAuthorization(strict,strict.integritySha256,manifest,replay,sha('newexe'),'STRICT_REALTIME',now).timingMode,'STRICT_REALTIME');
  for(const field of ['captureLockText','replayLockText'] as const){
    for(const [key,value] of Object.entries(JSON.parse(annex[field])))if(key.endsWith('Sha256')){
      assert.equal(typeof value,'string');const changed=structuredClone(annex),lock=JSON.parse(changed[field]);lock[key]=sha('changed');changed[field]=JSON.stringify(lock);assert.throws(()=>check(changed));
    }
  }
  for(const key of Object.keys(annex.recognition[0]!.configuration)){
    const changed:any=structuredClone(annex);changed.recognition[0].configuration[key]++;assert.throws(()=>check(changed));
  }
  const changed=structuredClone(annex);changed.recognition[1]!.threshold=.15;assert.throws(()=>check(changed));
});

test('source audit keeps capture, inference, resampling, strict pacing and rejected-push semantics isolated from replay waiting',async()=>{
  const source=await readFile(new URL('./native-live.cc',import.meta.url),'utf8');
  const capture=source.slice(source.indexOf('static void Capture('),source.indexOf('static void Replay('));
  const inference=source.slice(source.indexOf('static void Inference('),source.indexOf('static void Report('));
  assert.doesNotMatch(capture,/capacityWait|acousticBackpressure|beforeBlock/);assert.doesNotMatch(inference,/capacityWait|beforeBlock/);
  const producer=source.slice(source.indexOf('static void CalibrationReplay('),source.indexOf('// Hash only authorized replay PCM'));
  assert.match(producer,/s\.acousticBackpressure&&!s\.capacityWait\.beforeBlock/);
  assert.match(producer,/while\(!stopped\(s\)&&Wall\(\)<start\+\(at\+n\)\/16\.0\)WaitForSingleObject\(s\.stop\.h,1\)/);
  assert.match(producer,/WaitForSingleObject\(s\.stop\.h,5\)/);assert.equal((producer.match(/s\.queue\.push\(/g)??[]).length,1);
  assert.match(producer,/if\(!s\.queue\.push\(b,&pending\)\)\{s\.overflows\+\+;return false;\}/);
  assert.match(source,/if\(timingMode&&\(!calReplay\|\|/);
});
