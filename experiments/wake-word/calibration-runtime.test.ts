import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile,rm,mkdtemp,access,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { runLiveChild } from './native-live.js';
import { sha,sdkHashes } from './benchmark-contract.js';
import { liveConfiguration,liveKeyword } from './native-live-config.js';
import { validatePcm,retention,retentionMs,bindCalibrationWindows,validateCalReplay,associateCalibration,digest,calibrationFormat,captureSeconds,sessionSeconds,replaySeconds,validateCalCapture,maxCalibrationSamples,shortCalibrationSamples } from './calibration-contract.js';
import { requireConsent,calibrationRoot,safeLocal,eraseAcoustic,retentionStatus,loadCalibrationSession,compareCalibrationMatrices } from './calibration-session.js';

const trial='a'.repeat(32),models=Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(k=>[k,sha(k)]));
const zeros=(keys:string)=>Object.fromEntries(keys.split(' ').map(k=>[k,0]));
function captureReport(seconds=60):any{
  const blocks=Array.from({length:seconds*10},(_,sequence)=>({sequence,sampleStart:sequence*1600,sampleEnd:(sequence+1)*1600,samples:1600,
    qpcStartMs:1000+sequence*100,qpcEndMs:1100+sequence*100,sumSquares:0,rms:0,peak:0,nearZero:1600,clipped:0,invalid:0,metricsWallMs:.01,completed:true,decodeCalls:1,rawHits:0}));
  const markers=Array.from({length:40},(_,i)=>({id:i+1,kind:i%2?'E':'B',qpcMs:2000+Math.floor(i/2)*2500+(i%2?600:0)}));
  return {schema:1,backend:'NATIVE_LIVE',source:'MICROPHONE',state:'COMPLETED',code:'CAPTURE_COMPLETED',mode:'COLD',configuration:liveConfiguration(.15),
    thresholdEvidence:{spotterArgumentFloat32:Math.fround(.15)},runtime:{version:'2.0.0',dllHashes:sdkHashes},modelHashes:models,keywordSha256:sha(liveKeyword(.15)),
    wavSha256:null,pcmSha256:null,processedPcmSha256:null,format:{rate:48000,channels:1,containerBits:32,validBits:32,kind:'FLOAT32',selectedChannel:0,endpointBufferFrames:480},
    conversion:{outputRate:16000,firTaps:385,filterDelayMs:4,outputRms:0,outputPeak:0,outputClipped:0,appendedSamples:0},
    capture:{...zeros('unconvertedFrames silentFrames unprocessedSamples overflows discontinuities initialDiscontinuities sequenceErrors'),requestedSeconds:seconds,wallMs:seconds*1000,
      framesReceived:seconds*48000,framesConverted:seconds*48000,resampledSamples:seconds*16000,enqueuedBlocks:seconds*10,processedSamples:seconds*16000,processedBlocks:seconds*10},
    buffer:{...zeros('pendingAfterCleanup abandonedBlocksOnFailure maxQueueAgeMs maxBlockEndLatencyMs'),queuedCapacity:4,decoderBlocks:1,assemblerBlocks:1,highWater:2},
    preparation:{...zeros('wallMs resetWallMs syntheticBlocks decodeCalls'),initializationWallMs:100,newStream:true},
    inference:{decodeCalls:seconds*10,firstDecodeWallMs:10,medianDecodeWallMs:10,p95DecodeWallMs:10,maxDecodeWallMs:10,maxBlockWallMs:20,processingWallMs:seconds*100,threadCpuMs:5000,rtf:.1},
    recognition:{rawHits:0,detections:0,suppressedHits:0},channels:[{channel:0,samples:seconds*48000,rms:0,peak:0,clipped:0,nearZero:seconds*48000}],
    memory:{...zeros('residentStartBytes residentEndBytes peakResidentBytes residentAfterCleanupBytes'),residentWindows10s:Array(12).fill(null)},
    cleanup:{microphoneReleased:true,comReleased:true,engineReleased:true,threadsJoined:true,wallMs:1,microphoneReleaseWallMs:1,engineReleaseWallMs:1},positions:[],details:null,
    fnDiagnostics:{schema:1,trialId:trial,clock:'QPC_RELATIVE_MS',signalDomain:'POST_FIR_MONO_16000',channelHealthy:true,blocks,
      decodes:blocks.map(b=>({block:b.sequence,startMs:b.qpcEndMs+1,endMs:b.qpcEndMs+2})),markers,hostMarkers:markers.map(m=>({...m,acknowledged:true,roundTripMs:10}))}};
}
function replayReport(threshold=.15,hits:number[]=[],seconds=60):any{
  const r=captureReport(seconds);delete r.fnDiagnostics;
  r.source='REPLAY';r.runtime={version:'2.0.0',dlls:['sherpa-onnx-c-api.dll','onnxruntime.dll'].map(name=>({name,sha256:sdkHashes[name]}))};
  r.configuration=liveConfiguration(threshold);r.keywordSha256=sha(liveKeyword(threshold));r.thresholdEvidence.spotterArgumentFloat32=Math.fround(threshold);
  r.pcmSha256=sha(Buffer.alloc(seconds*16000*4));r.processedPcmSha256=r.pcmSha256;r.calibration={schema:1,mode:'REPLAY',persisted:false,samples:seconds*16000,sha256:r.pcmSha256};
  r.format.rate=16000;r.conversion.firTaps=1;r.conversion.filterDelayMs=0;r.capture.framesReceived=r.capture.framesConverted=seconds*16000;r.channels[0].samples=seconds*16000;
  r.positions=hits.map(block=>({block,blockCompleted:true,audioSampleEnd:(block+1)*1600,startTimeSec:0,timestampsSec:[1],latencyFromBlockEndMs:20,acousticLatencyMs:null}));
  let last=-Infinity,accepted=0;for(const block of hits)if(block*100-last>=1000){last=block*100;accepted++;}
  r.recognition={rawHits:hits.length,detections:accepted,suppressedHits:hits.length-accepted};
  r.details={decodes:Array.from({length:seconds*10},(_,block)=>({block,wallMs:10,threadCpuMs:8})),
    blocks:Array.from({length:seconds*10},(_,sequence)=>({sequence,wallMs:20,decodeCalls:1,rawHits:hits.filter(b=>b===sequence).length}))};return r;
}
test('capture consent is unique, explicit, per invocation and never an inferred default',async()=>{
  await assert.rejects(requireConsent('POSITIVE',trial,async()=>''),{message:'CAL_CAPTURE_CONSENT_REQUIRED'});
  let calls=0;await requireConsent('SILENCE',trial,async text=>{calls++;assert.match(text,/7 días/);return `CAPTURAR SILENCE ${trial}`;});assert.equal(calls,1);
  await assert.rejects(requireConsent('SIMILAR',trial,async()=>`CAPTURAR POSITIVE ${trial}`));
  for(const kind of ['POSITIVE','SIMILAR'] as const)await requireConsent(kind,trial,async text=>{
    assert.match(text,/120 s/);return `CAPTURAR ${kind} ${trial}`;
  });
});
test('duration policy is 120 s for positive/similar, 60 s for silence; legacy accepted data remains readable',()=>{
  for(const kind of ['POSITIVE','SIMILAR'] as const){assert.equal(captureSeconds(kind),120);assert.equal(sessionSeconds({kind}),60);
    assert.equal(sessionSeconds({kind,requestedSeconds:120}),120);}
  assert.equal(captureSeconds('SILENCE'),60);assert.throws(()=>sessionSeconds({kind:'SILENCE',requestedSeconds:120}),{message:'CAL_DURATION_INVALID'});
  for(const seconds of [0,90,121,NaN])assert.throws(()=>sessionSeconds({kind:'POSITIVE',requestedSeconds:seconds}));
  assert.equal(replaySeconds({kind:'POSITIVE',requestedSeconds:120,samples:120*16000+1}),121);
  assert.equal(replaySeconds({kind:'POSITIVE',requestedSeconds:120,samples:maxCalibrationSamples}),124);
  assert.throws(()=>replaySeconds({kind:'SILENCE',samples:shortCalibrationSamples+1}));
});
test('120-second diagnostics accept exactly 20 completed B/E windows, including late utterances; 33 ACKs still fail',()=>{
  for(const kind of ['POSITIVE','SIMILAR'] as const){
    const r=captureReport(120);
    for(let i=0;i<40;i++){const qpc=2000+Math.floor(i/2)*5000+(i%2?600:0);r.fnDiagnostics.markers[i].qpcMs=qpc;r.fnDiagnostics.hostMarkers[i].qpcMs=qpc;}
    const clean=validateCalCapture(r,kind,120);assert.equal(clean.capture.processedBlocks,1200);
    const badCounts=structuredClone(r);badCounts.recognition.rawHits=badCounts.recognition.detections=1;
    assert.throws(()=>validateCalCapture(badCounts,kind,120),{message:'CAL_HIT_ACCOUNTING_INVALID'});
    const windows=bindCalibrationWindows(clean,kind);assert.equal(windows.length,20);assert.ok(windows[19].begin.lower>90*16000);
    const incomplete=structuredClone(r);incomplete.fnDiagnostics.markers=incomplete.fnDiagnostics.markers.slice(0,33);incomplete.fnDiagnostics.hostMarkers=incomplete.fnDiagnostics.hostMarkers.slice(0,33);
    assert.throws(()=>bindCalibrationWindows(incomplete,kind),{message:'CAL_ALIGNMENT_AMBIGUOUS'});
    r.state='CANCELLED';r.code='CAPTURE_INCOMPLETE';r.capture.wallMs=119999;
    assert.throws(()=>bindCalibrationWindows(validateCalCapture(r,kind,120),kind),{message:'CAL_CAPTURE_INCOMPLETE'});
  }
  const silence=captureReport(120);assert.throws(()=>validateCalCapture(silence,'SILENCE',120),{message:'CAL_DURATION_INVALID'});
  assert.throws(()=>validateCalCapture(captureReport(120),'POSITIVE',60));
});
test('replay validates all 120 s of PCM and the declared duration without weakening hash or cleanup checks',()=>{
  const r=replayReport(.15,[12,1112],120),m={kind:'POSITIVE',requestedSeconds:120,samples:120*16000,pcmSha256:r.pcmSha256,modelHashes:models};
  const expected={modelHashes:models,keywordSha256:sha(liveKeyword(.15))};
  assert.equal(validateCalReplay(r,expected,m,.15).capture.processedBlocks,1200);
  assert.throws(()=>validateCalReplay(r,expected,{...m,requestedSeconds:60},.15));
  const broken=structuredClone(r);broken.cleanup.microphoneReleased=false;assert.throws(()=>validateCalReplay(broken,expected,m,.15));
  const mutated=structuredClone(r);mutated.processedPcmSha256='0'.repeat(64);assert.throws(()=>validateCalReplay(mutated,expected,m,.15));
});
test('120-second supervision permits capture plus preparation budget; cancellation still sends Stop and enforces its existing watchdog',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  const writes:string[]=[];let kills=0;child.stdin.write=(v:string)=>writes.push(v);child.stdin.destroy=()=>{};child.kill=()=>{kills++;child.emit('close',2);};
  const controller=new AbortController(),p=runLiveChild('owned.exe',[],captureSeconds('POSITIVE'),controller.signal,()=>{},()=>child);
  const failure=assert.rejects(p,{message:'NATIVE_LIVE_TIMEOUT'});
  t.mock.timers.tick(179999);assert.equal(writes.length,0);t.mock.timers.tick(1);assert.deepEqual(writes,['S']);
  t.mock.timers.tick(4999);assert.equal(kills,0);t.mock.timers.tick(1);assert.equal(kills,1);await failure;
  const cancelled:any=new EventEmitter();cancelled.stdout=new EventEmitter();cancelled.stderr=new EventEmitter();cancelled.stdin=new EventEmitter();
  cancelled.stdin.write=()=>queueMicrotask(()=>{cancelled.stdout.emit('data',Buffer.from('{"state":"CANCELLED"}'));cancelled.emit('close',130);});cancelled.stdin.destroy=()=>{};cancelled.kill=()=>assert.fail('cooperative cancellation must not need a kill');
  const abort=new AbortController(),q=runLiveChild('owned.exe',[],120,abort.signal,()=>{},()=>cancelled);abort.abort();assert.equal((await q).exitCode,130);
});
test('F32LE integrity is byte-exact including negative zero; no quantization or normalization',()=>{
  const bytes=Buffer.alloc(16);[-0,.123456789,-.8,0].forEach((v,i)=>bytes.writeFloatLE(v,i*4));const original=Buffer.from(bytes);
  validatePcm(bytes,sha(bytes),4);assert.deepEqual(bytes,original);
  bytes.writeFloatLE(0,0);assert.throws(()=>validatePcm(bytes,sha(original),4),{message:'CAL_PCM_HASH_MISMATCH'});
  assert.throws(()=>validatePcm(bytes,sha(bytes),5),{message:'CAL_PCM_LENGTH_INVALID'});
  bytes.writeFloatLE(NaN,0);assert.throws(()=>validatePcm(bytes,sha(bytes),4),{message:'CAL_PCM_INVALID'});
});
test('QPC to samples preserves offset and uncertainty; clocks are not aligned by shifting hits',()=>{
  const r=captureReport(),w=bindCalibrationWindows(r,'POSITIVE');assert.equal(w.length,20);
  assert.equal(w[0].begin.lower,15808);assert.equal(w[0].begin.upper,16032);assert.equal(w[0].begin.offsetLowerMs,998);
  assert.equal(w[0].begin.offsetUpperMs,1012);assert.equal(w[0].begin.uncertaintySamples,224);
  const before=JSON.stringify(r);bindCalibrationWindows(r,'SIMILAR');assert.equal(JSON.stringify(r),before);
});
test('late/missing ACKs, overlapping windows, missing coverage and discontinuous mapping fail closed',()=>{
  for(const mutate of [(r:any)=>r.fnDiagnostics.hostMarkers[0].roundTripMs=51,
    (r:any)=>r.fnDiagnostics.hostMarkers.pop(),(r:any)=>{r.fnDiagnostics.markers[2].qpcMs=3000;r.fnDiagnostics.hostMarkers[2].qpcMs=3000;},
    (r:any)=>{for(const b of r.fnDiagnostics.blocks.slice(9)){b.qpcStartMs+=3;b.qpcEndMs+=3;}}]){
    const r=captureReport();mutate(r);assert.throws(()=>bindCalibrationWindows(r,'POSITIVE'));
  }
  const r=captureReport();assert.throws(()=>bindCalibrationWindows(r,'SILENCE'));r.fnDiagnostics.markers=[];r.fnDiagnostics.hostMarkers=[];
  assert.deepEqual(bindCalibrationWindows(r,'SILENCE'),[]);r.state='CANCELLED';assert.throws(()=>bindCalibrationWindows(r,'SILENCE'));
});
test('new replay contract rechecks threshold, raw float identity, hash at Feed, sample order and all counters',()=>{
  for(const threshold of [.15,.1,.05]){
    const r=replayReport(threshold,[0,12,13,22]),session={kind:'POSITIVE',samples:960000,pcmSha256:r.pcmSha256,modelHashes:models};
    const expected={modelHashes:models,keywordSha256:sha(liveKeyword(threshold))};
    assert.equal(validateCalReplay(r,expected,session,threshold).recognition.rawHits,4);
    for(const mutate of [(x:any)=>x.processedPcmSha256='0'.repeat(64),(x:any)=>x.positions.reverse(),(x:any)=>x.capture.processedSamples--,
      (x:any)=>x.configuration.score=2,(x:any)=>x.calibration.samples++,(x:any)=>x.thresholdEvidence.spotterArgumentFloat32=.25,
      (x:any)=>x.details.blocks[12].rawHits=0,(x:any)=>x.details.decodes.reverse(),(x:any)=>x.state='CANCELLED']){
      const x=structuredClone(r);mutate(x);assert.throws(()=>validateCalReplay(x,expected,session,threshold));}
    assert.throws(()=>validateCalReplay(r,expected,session,.25));
  }
});
test('same sample windows distinguish associated hits, cooldown, duplicate detections, omissions and controls',()=>{
  const r=replayReport(.15,[0,12,13,22]),session={kind:'POSITIVE',samples:960000,pcmSha256:r.pcmSha256,modelHashes:models,
    windows:bindCalibrationWindows(captureReport(),'POSITIVE'),annotationSha256:sha('annotations')};
  const s=associateCalibration(r,session);assert.equal(s.associatedPronunciations,1);assert.equal(s.omissions,19);assert.equal(s.duplicates,1);
  assert.equal(s.falsePositives,1);assert.equal(s.suppressedHits,1);assert.equal(s.sensitivity,.05);assert.equal(s.rawHits,4);
  assert.equal(associateCalibration(r,{...session,kind:'SIMILAR'}).falsePositives,3);
  const changed=structuredClone(r);changed.positions[1].audioSampleEnd=session.windows[0].begin.lower-4000;
  assert.throws(()=>associateCalibration(changed,session),{message:'CAL_HIT_AMBIGUOUS'});
  assert.equal(s.recognitionSignature,associateCalibration(structuredClone(r),session).recognitionSignature);
});
test('retention never extends on replay and logical deletion is manual, narrow and verified',async()=>{
  const session=randomBytes(16).toString('hex'),dir=join(calibrationRoot,'captures',session);await mkdir(dir,{recursive:true});
  try{const created=Date.now()-8*24*60*60*1000,c={schema:1,contract:'ATLAS_CALIBRATION_F32LE_V1',trialId:session,kind:'SILENCE',consent:'EXPLICIT_PER_CAPTURE',
      createdAtUtc:new Date(created).toISOString(),expiresAtUtc:new Date(created+retentionMs).toISOString()};
    await writeFile(join(dir,'consent.json'),JSON.stringify(c));await writeFile(join(dir,'capture.f32le'),Buffer.alloc(4));
    assert.equal(retention(c.createdAtUtc,c.expiresAtUtc),'EXPIRED');assert.equal((await retentionStatus()).find(x=>x.sessionId===session)?.warning,true);
    await assert.rejects(loadCalibrationSession(session),{message:'CAL_RETENTION_EXPIRED'});
    await assert.rejects(eraseAcoustic(session,'YES'));await access(join(dir,'capture.f32le'));
    const erased=await eraseAcoustic(session,`BORRAR ${session}`);assert.equal(erased.physicalErasureGuaranteed,false);
    await assert.rejects(access(join(dir,'capture.f32le')));await access(join(dir,'consent.json'));
    assert.equal((await retentionStatus()).find(x=>x.sessionId===session)?.acousticPresent,false);
    assert.throws(()=>retention(c.createdAtUtc,new Date(created+retentionMs+1).toISOString()));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('storage refuses links and escape paths without reading or deleting their targets',async(t)=>{
  if(process.platform!=='linux'){t.skip('Windows reparse/ACL acceptance pending');return;}
  const dir=await mkdtemp(join(tmpdir(),'cal-privacy-')),link=join(calibrationRoot,randomBytes(8).toString('hex'));
  try{await mkdir(calibrationRoot,{recursive:true});await symlink(dir,link);await assert.rejects(safeLocal(join(link,'capture.f32le'),true),{message:'CAL_PATH_INVALID'});
    await assert.rejects(safeLocal(join(tmpdir(),'capture.f32le'),true),{message:'CAL_PATH_INVALID'});
  }finally{await rm(link,{force:true});await rm(dir,{recursive:true,force:true});}
});
test('a complete synthetic dataset rebinds report, PCM and annotations; editing any identity cannot force equivalence',async()=>{
  for(const seconds of [60,120]){
  const session=randomBytes(16).toString('hex'),dir=join(calibrationRoot,'captures',session);await mkdir(dir,{recursive:true});
  const samples=seconds*16000,pcm=Buffer.alloc(samples*4),r=captureReport(seconds);r.fnDiagnostics.trialId=session;
  r.calibration={schema:1,mode:'CAPTURE',persisted:true,samples,sha256:sha(pcm)};
  const now=Date.now(),consent={schema:1,contract:'ATLAS_CALIBRATION_F32LE_V1',trialId:session,kind:'POSITIVE',...(seconds===120?{requestedSeconds:120}:{}),consent:'EXPLICIT_PER_CAPTURE',
    createdAtUtc:new Date(now).toISOString(),expiresAtUtc:new Date(now+retentionMs).toISOString()};
  const reportBytes=Buffer.from(JSON.stringify(r)),windows=bindCalibrationWindows(r,'POSITIVE');
  const manifest={...consent,state:'COMPLETE',format:calibrationFormat,samples,pcmSha256:sha(pcm),reportSha256:sha(reportBytes),windows,annotationSha256:digest(windows),modelHashes:models,lockSha256:sha('lock')};
  try{await writeFile(join(dir,'consent.json'),JSON.stringify(consent));await writeFile(join(dir,'capture.json'),reportBytes);
    await writeFile(join(dir,'capture.f32le'),pcm);await writeFile(join(dir,'session.json'),JSON.stringify(manifest));
    assert.deepEqual((await loadCalibrationSession(session)).manifest,manifest);
    const altered=structuredClone(manifest);altered.windows[0].begin.lower--;altered.annotationSha256=digest(altered.windows);
    await writeFile(join(dir,'session.json'),JSON.stringify(altered));await assert.rejects(loadCalibrationSession(session),{message:'CAL_ANNOTATION_INVALID'});
    await writeFile(join(dir,'session.json'),JSON.stringify({...manifest,pcmSha256:sha('replacement')}));await assert.rejects(loadCalibrationSession(session),{message:'CAL_SESSION_INVALID'});
    await writeFile(join(dir,'session.json'),JSON.stringify(manifest));pcm[0]=1;await writeFile(join(dir,'capture.f32le'),pcm);
    await assert.rejects(loadCalibrationSession(session),{message:'CAL_PCM_HASH_MISMATCH'});
  }finally{pcm.fill(0);await rm(dir,{recursive:true,force:true});}
  }
});
test('all nine cells are compared exactly by acoustic results while timing variability is diagnostic only',()=>{
  const rows=['POSITIVE','SILENCE','SIMILAR'].flatMap(kind=>[.15,.1,.05].map(threshold=>({kind,threshold,sessionId:trial,pcmSha256:sha(kind),samples:960000,annotationSha256:sha(kind+'a'),
    recognitionSignature:sha(kind+threshold),rawHits:1,detections:1,suppressedHits:0,associatedPronunciations:kind==='POSITIVE'?1:null,omissions:kind==='POSITIVE'?19:null,duplicates:0,falsePositives:kind==='POSITIVE'?0:1})));
  const body={schema:1,state:'NINE_EXPERIMENTAL_EVALUATIONS_COMPLETE',runId:'1'.repeat(32),referenceThreshold:.15,modelIdentity:sha('models'),rows};
  const a={...body,integritySha256:digest(body)},independent={...body,runId:'2'.repeat(32)};
  assert.equal(compareCalibrationMatrices(a,{...independent,integritySha256:digest(independent)}).cells,9);
  assert.throws(()=>compareCalibrationMatrices(a,a),{message:'CAL_INDEPENDENT_RUNS_REQUIRED'});
  const b=structuredClone(independent);b.rows[1]!.rawHits=2;b.rows[1]!.detections=2;
  assert.throws(()=>compareCalibrationMatrices(a,{...b,integritySha256:digest(b)}),{message:'CAL_RESULTS_INCONSISTENT'});
  const bad=structuredClone(a);bad.rows[0]!.threshold=.25;assert.throws(()=>compareCalibrationMatrices(a,bad));
  const invalidSilence:any=structuredClone(independent);invalidSilence.rows[3].requestedSeconds=120;
  assert.throws(()=>compareCalibrationMatrices(a,{...invalidSilence,integritySha256:digest(invalidSilence)}),{message:'CAL_DURATION_INVALID'});
});
test('portable Native tap preserves byte values and order, refuses overflow, and wipes all samples on cleanup',async(t)=>{
  if(process.platform!=='linux'){t.skip('Portable compiler check; MSVC separate');return;}
  const dir=await mkdtemp(join(tmpdir(),'cal-core-'));
  try{const cpp=join(dir,'test.cc'),exe=join(dir,'test');
    await writeFile(cpp,`#include "${join(process.cwd(),'experiments/wake-word/native-calibration-core.h')}"\n#include <iostream>\nint main(){if(atlas_cal::captureSeconds("POSITIVE")!=120||atlas_cal::captureSeconds("SIMILAR")!=120||atlas_cal::captureSeconds("SILENCE")!=60)return 5;atlas_cal::Buffer b;b.prepare();float p[1600]{};p[0]=-0.0f;p[1]=.123456789f;b.append(p,1600,0);if(std::memcmp(b.data(),p,sizeof(p)))return 1;bool failed=false;try{b.append(p,1,0);}catch(...){failed=true;}if(!failed)return 2;b.wipe();if(b.size())return 3;b.prepare(atlas_cal::maxSamples);for(size_t i=0;i<atlas_cal::maxSamples/1600;i++)b.append(p,1600,i*1600);failed=false;try{b.append(p,1,b.size());}catch(...){failed=true;}if(!failed)return 4;b.wipe();atlas_cal::Buffer shortBuffer;shortBuffer.prepare();for(size_t i=0;i<atlas_cal::shortMaxSamples/1600;i++)shortBuffer.append(p,1600,i*1600);failed=false;try{shortBuffer.append(p,1,shortBuffer.size());}catch(...){failed=true;}if(!failed)return 6;shortBuffer.wipe();std::cout<<"PASS";}`);
    await promisify(execFile)('g++',['-std=c++17','-O2','-Wall','-Wextra','-Werror',cpp,'-o',exe]);
    assert.equal((await promisify(execFile)(exe)).stdout,'PASS');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('capture and historical replay remain untouched; persistence happens only after audio cleanup and never appears in JSON',async()=>{
  const s=await readFile('experiments/wake-word/native-live.cc','utf8');
  const capture=s.slice(s.indexOf('static void Capture('),s.indexOf('static void Replay('));assert.doesNotMatch(capture,/calSave|recording|WriteFile|ofstream/);
  assert.ok(s.indexOf('SaveCalibration(s);')>s.indexOf('if(capture.joinable())capture.join();'));
  assert.match(s,/s\.calSave&&!s\.error\.load\(\)&&!s\.cancelled\.load/);assert.match(s,/CREATE_NEW/);
  assert.match(s,/if\(replay && threshold!=\.25\)/);assert.match(s,/if\(calReplay\).*CalibrationReplay/);
  const jsonSection=s.slice(s.indexOf('static void Report('),s.indexOf('static int NativeLive('));assert.doesNotMatch(jsonSection,/recording\.data|recording\[|pcm\.data/);
});
