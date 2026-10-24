import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { configuration, expectedPcm, sdkHashes, sha } from '../../experiments/wake-word/benchmark-contract.js';
import { cleanLiveReport, compareReplay, runLiveChild } from '../../experiments/wake-word/native-live.js';

const expected={modelHashes:{'encoder.onnx':sha('encoder'),'decoder.onnx':sha('decoder'),'joiner.onnx':sha('joiner'),'tokens.txt':sha('tokens')},
  keywordSha256:sha('▁a t la s :1 #0.25 @sherpaw_0'),wavSha256:sha('authorized-wave'),pcmSha256:expectedPcm};
const schedule=[...Array.from({length:63},(_,i)=>4+i*3),27].sort((a,b)=>a-b);
function fixture(replay=false):any{
  const samples=replay?330411:960000,blocks=Math.ceil(samples/1600);
  return {schema:1,backend:'NATIVE_LIVE',source:replay?'REPLAY':'MICROPHONE',state:'COMPLETED',code:'CAPTURE_COMPLETED',mode:'WARM',configuration,
    runtime:{version:'2.0.0',dlls:Object.entries(sdkHashes).slice(0,2).map(([name,sha256])=>({name,sha256}))},modelHashes:expected.modelHashes,keywordSha256:expected.keywordSha256,
    wavSha256:replay?expected.wavSha256:null,pcmSha256:replay?expectedPcm:null,processedPcmSha256:replay?expectedPcm:null,
    format:{rate:replay?16000:48000,channels:replay?1:2,containerBits:replay?16:32,validBits:replay?16:32,kind:replay?'PCM16':'FLOAT32',selectedChannel:0,endpointBufferFrames:480},
    conversion:{outputRate:16000,firTaps:replay?1:385,filterDelayMs:replay?0:4,outputRms:.02,outputPeak:.4,outputClipped:0,appendedSamples:0},
    capture:{requestedSeconds:60,wallMs:replay?20651:60001,framesReceived:replay?samples:2880000,framesConverted:replay?samples:2880000,unconvertedFrames:0,resampledSamples:samples,
      enqueuedBlocks:Math.floor(samples/1600),processedSamples:samples,processedBlocks:blocks,silentFrames:0,unprocessedSamples:0,overflows:0,discontinuities:0,initialDiscontinuities:1,sequenceErrors:0},
    buffer:{queuedCapacity:4,decoderBlocks:1,assemblerBlocks:1,highWater:2,pendingAfterCleanup:0,abandonedBlocksOnFailure:0,maxQueueAgeMs:15,maxBlockEndLatencyMs:45},
    preparation:{initializationWallMs:100,wallMs:100,resetWallMs:1,syntheticBlocks:9,decodeCalls:2,newStream:true},
    inference:{decodeCalls:replay?64:186,firstDecodeWallMs:30,medianDecodeWallMs:30,p95DecodeWallMs:45,maxDecodeWallMs:80,maxBlockWallMs:90,processingWallMs:6000,threadCpuMs:5000,rtf:.1},
    recognition:{rawHits:3,detections:3,suppressedHits:0},channels:Array.from({length:replay?1:2},(_,channel)=>({channel,samples:replay?samples:2880000,rms:.02,peak:.4,clipped:0,nearZero:12})),
    memory:{residentStartBytes:100000000,residentEndBytes:110000000,peakResidentBytes:120000000,residentAfterCleanupBytes:90000000,residentWindows10s:Array(12).fill(null)},
    cleanup:{microphoneReleased:true,comReleased:true,engineReleased:true,threadsJoined:true,wallMs:1,microphoneReleaseWallMs:1,engineReleaseWallMs:1},
    positions:[27,46,91].map(block=>({block,blockCompleted:true,audioSampleEnd:(block+1)*1600,startTimeSec:0,timestampsSec:[block/10],latencyFromBlockEndMs:45,acousticLatencyMs:null})),
    details:replay?{decodes:schedule.map(block=>({block,wallMs:30,threadCpuMs:25})),blocks:Array.from({length:207},(_,sequence)=>({sequence,wallMs:1,decodeCalls:Number(schedule.includes(sequence)),rawHits:Number([27,46,91].includes(sequence))}))}:null};
}
function wasmFixture():any{
  const r=fixture(true);
  return {schema:1,state:'COMPLETED',backend:'WASM',mode:'WARM',runtime:{version:'@sherpaw/kws 0.3.0'},configuration,...expected,
    processedSamples:330411,blocks:207,rawHits:3,detections:3,suppressedHits:0,appendedSilenceSamples:0,
    events:[27,46,91].map(block=>({block,sampleOffset:block*1600,sampleEnd:(block+1)*1600,rawHits:1})),
    hitPositions:r.positions.map((p:any)=>({block:p.block,startTimeSec:p.startTimeSec,timestampsSec:p.timestampsSec})),
    moduleLoadWallMs:5,initializationWallMs:100,preparation:r.preparation,processing:{wallMs:1000,threadCpuMs:900,rtf:1000/(330411/16),maxBlockWallMs:1},
    decodes:r.details.decodes,blockMetrics:r.details.blocks.map((b:any)=>({...b,threadCpuMs:.5})),
    memory:{residentStartBytes:100,residentEndBytes:110,residentPeakBytes:120,peakKind:'SAMPLED_PROCESS_RSS',wasmHeapBytes:512*1024*1024},cleanupCompleted:true};
}
test('portable C++ tests exercise rational clock, FIR, channels, bounded SPSC and terminal overflow with real compiled code',async(t)=>{
  if(process.platform!=='linux'){t.skip('Portable compiler test runs in Linux; MSVC/hardware acceptance is separate');return;}
  const dir=await mkdtemp(join(tmpdir(),'atlas-live-core-'));
  try{
    const exe=join(dir,'core-test');
    await promisify(execFile)('g++',['-std=c++17','-O2','-pthread','-Wall','-Wextra','-Werror','experiments/wake-word/native-live-core.test.cc','-o',exe],{timeout:30000});
    const {stdout}=await promisify(execFile)(exe,[],{timeout:30000});const result=JSON.parse(stdout);
    assert.equal(result.state,'PASS');assert.ok(result.portableChecks>=55);assert.equal(result.hardwareValidated,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('reports expose numeric channels, queue delay, CPU scope and partial acceptance without private payloads',()=>{
  const r=fixture();r.deviceId='PRIVATE_DEVICE';r.channels[0].pcm='PRIVATE_PCM';r.positions[0].transcript='PRIVATE_TEXT';r.memory.privatePath='PRIVATE_PATH';
  const clean=cleanLiveReport(r,expected,'WARM','MICROPHONE',60);
  assert.equal(clean.technicalThresholdsMet,true);assert.equal(clean.acceptance,'MANUAL_REVIEW_REQUIRED');assert.equal(clean.positions![0]!.acousticLatencyMs,null);
  assert.doesNotMatch(JSON.stringify(clean),/PRIVATE_/);
  const cancelled=fixture();cancelled.state='CANCELLED';cancelled.code='CAPTURE_INCOMPLETE';cancelled.capture.wallMs=200;
  assert.equal(cleanLiveReport(cancelled,expected,'WARM','MICROPHONE',60).technicalThresholdsMet,false);
  assert.equal(cleanLiveReport({schema:1,state:'FAILED',code:'PRIVATE_ERROR'},expected,'WARM','MICROPHONE',60).code,'NATIVE_LIVE_FAILED');
});
test('inconsistent completion, discontinuity, overflow, changed parameters and incomplete cleanup fail closed',()=>{
  const mutations=[(r:any)=>r.configuration={...configuration,threshold:.05},(r:any)=>r.capture.overflows=1,(r:any)=>r.capture.discontinuities=1,
    (r:any)=>r.capture.processedSamples--,(r:any)=>r.capture.framesReceived--,(r:any)=>r.capture.wallMs=59999,
    (r:any)=>r.cleanup.microphoneReleased=false,(r:any)=>r.preparation.newStream=false,(r:any)=>r.preparation.decodeCalls=1,
    (r:any)=>r.buffer.queuedCapacity=8,(r:any)=>r.buffer.pendingAfterCleanup=1,(r:any)=>r.conversion.appendedSamples=1600,
    (r:any)=>r.inference.maxBlockWallMs=null,(r:any)=>r.channels[0].rms=NaN];
  for(const mutate of mutations){const r=fixture();mutate(r);assert.throws(()=>cleanLiveReport(r,expected,'WARM','MICROPHONE',60),/NATIVE_LIVE_REPORT_INVALID/);}
  const slow=fixture();slow.inference.firstDecodeWallMs=220;
  assert.equal(cleanLiveReport(slow,expected,'WARM','MICROPHONE',60).technicalThresholdsMet,false);
});
test('identical authorized replay compares hashes, samples, calls and exact positions; independent Live never qualifies',()=>{
  const corrupt=fixture(true);corrupt.processedPcmSha256=sha('corrupt-transport');
  assert.throws(()=>cleanLiveReport(corrupt,expected,'WARM','REPLAY',60),/NATIVE_LIVE_REPORT_INVALID/);
  const native=cleanLiveReport(fixture(true),expected,'WARM','REPLAY',60);
  assert.equal(compareReplay(native,wasmFixture()).state,'EQUIVALENT_ON_AUTHORIZED_PCM_ONLY');
  const changes=[(w:any)=>w.rawHits=2,(w:any)=>w.pcmSha256=sha('different'),(w:any)=>w.hitPositions[0].timestampsSec[0]+=.01,
    (w:any)=>w.decodes.pop(),(w:any)=>w.configuration={...configuration,score:2}];
  for(const change of changes){const w=wasmFixture();change(w);assert.throws(()=>compareReplay(native,w),/REPLAY_EQUIVALENCE_FAILED/);}
  assert.throws(()=>compareReplay(cleanLiveReport(fixture(),expected,'WARM','MICROPHONE',60),wasmFixture()),/REPLAY_EQUIVALENCE_FAILED/);
});
function fakeChild(onStop?:()=>void){
  const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.writes=[];child.killed=0;child.stdin.write=(value:string)=>{child.writes.push(value);queueMicrotask(()=>onStop?.());};child.stdin.destroy=()=>{};
  child.kill=()=>{child.killed++;child.emit('close',2);};return child;
}
test('supervisor Stop is cooperative, idempotent and ignores late stages after child close',async()=>{
  const controller=new AbortController(),progress:string[]=[];
  const child=fakeChild(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({state:'CANCELLED'})));child.emit('close',130);});
  const result=runLiveChild('owned.exe',[],60,controller.signal,s=>progress.push(s),()=>child);
  child.stderr.emit('data',Buffer.from('PRIVATE_PATH\nCAPTURE_STARTED\n'));
  controller.abort();controller.abort();assert.equal((await result).exitCode,130);assert.deepEqual(child.writes,['S']);assert.equal(child.killed,0);
  child.stderr.emit('data',Buffer.from('CAPTURE_STOPPED\n'));assert.deepEqual(progress,['CAPTURE_STARTED']);
});
test('supervisor rejects invalid JSON and startup failure without raw stderr or automatic retries',async()=>{
  for(const startup of [false,true]){
    const child=fakeChild();let calls=0;
    const result=runLiveChild('owned.exe',[],60,new AbortController().signal,()=>{},()=>{calls++;return child;});
    child.stderr.emit('data',Buffer.from('PRIVATE_NATIVE_ERROR'));
    if(startup)child.emit('error',Error('PRIVATE_PATH'));else child.stdout.emit('data',Buffer.from('not json PRIVATE_PCM'));
    child.emit('close',2);await assert.rejects(result,/NATIVE_LIVE_CHILD_FAILED/);assert.equal(calls,1);
  }
});
test('watchdog requests Stop before terminating only its owned benchmark child',async()=>{
  const child=fakeChild();const result=runLiveChild('owned.exe',[],1,new AbortController().signal,()=>{},()=>child,5);
  // Simulate a process acknowledging Stop with a failure; no actual process is killed.
  await new Promise(resolve=>setTimeout(resolve,15));assert.deepEqual(child.writes,['S']);assert.equal(child.killed,0);
  child.emit('close',2);await assert.rejects(result,/NATIVE_LIVE_TIMEOUT/);
});
test('native source keeps capture apart from decoder and exposes no network, persistent audio or hidden conversion',async()=>{
  const source=await readFile('experiments/wake-word/native-live.cc','utf8');
  const capture=source.slice(source.indexOf('static void Capture('),source.indexOf('static void Replay('));
  assert.doesNotMatch(capture,/SherpaOnnxDecode|Feed\(/);assert.match(capture,/AUDCLNT_SHAREMODE_SHARED/);
  assert.match(capture,/Check\(packet.release\(\)/);assert.match(source,/s\.captureFinished\.store\(true,std::memory_order_release\)/);
  assert.doesNotMatch(source,/ofstream|socket\(|WinHttp|URLDownload|InputFinished\s*\(|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM/);
  assert.match(source,/while\s*\(synthetic.calls < 2/);assert.match(source,/ReplaceStream\(spotter.get\(\), stream\)/);
  const scripts=await readFile('experiments/wake-word/build-native-reference.ps1','utf8');assert.match(scripts,/\[switch\]\$Live/);assert.match(scripts,/coreSourceSha256/);
});
