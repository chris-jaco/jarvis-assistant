import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdtemp,rm,mkdir } from 'node:fs/promises';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration,sha,sdkHashes } from '../../experiments/wake-word/benchmark-contract.js';
import { parseThreshold,parseLiveFlags,liveConfiguration,liveKeyword } from '../../experiments/wake-word/native-live-config.js';
import { cleanLiveReport } from '../../experiments/wake-word/native-live.js';
import { annotationTemplate,matchingMargin,sensitivityTrial,ManualWindows } from '../../experiments/wake-word/native-sensitivity.js';

const modelHashes={'encoder.onnx':sha('encoder'),'decoder.onnx':sha('decoder'),'joiner.onnx':sha('joiner'),'tokens.txt':sha('tokens')};
const reportHash=sha('exact local report bytes');
const windows=Array.from({length:20},(_,i)=>({id:i+1,startMs:500+i*2500,endMs:900+i*2500}));
const hitBlocks=windows.map(w=>(w.startMs+300)/100-1);
function rawReport(threshold=.25,blocks=hitBlocks):any{
  let last=-Infinity,detections=0;for(const b of blocks)if(b*100-last>=1000){detections++;last=b*100;}
  return {schema:1,backend:'NATIVE_LIVE',state:'COMPLETED',code:'CAPTURE_COMPLETED',source:'MICROPHONE',mode:'COLD',
    configuration:liveConfiguration(threshold),thresholdEvidence:{spotterArgumentFloat32:Math.fround(threshold)},
    runtime:{version:'2.0.0',dlls:Object.entries(sdkHashes).slice(0,2).map(([name,sha256])=>({name,sha256}))},
    modelHashes,keywordSha256:sha(liveKeyword(threshold)),wavSha256:null,pcmSha256:null,processedPcmSha256:null,
    format:{rate:48000,channels:2,containerBits:32,validBits:32,kind:'FLOAT32',selectedChannel:0,endpointBufferFrames:480},
    conversion:{outputRate:16000,firTaps:385,filterDelayMs:4,outputRms:.02,outputPeak:.3,outputClipped:0,appendedSamples:0},
    capture:{requestedSeconds:60,wallMs:60001,framesReceived:2880000,framesConverted:2880000,unconvertedFrames:0,resampledSamples:960000,
      enqueuedBlocks:600,processedSamples:960000,processedBlocks:600,silentFrames:0,unprocessedSamples:0,overflows:0,discontinuities:0,initialDiscontinuities:1,sequenceErrors:0},
    buffer:{queuedCapacity:4,decoderBlocks:1,assemblerBlocks:1,highWater:2,pendingAfterCleanup:0,abandonedBlocksOnFailure:0,maxQueueAgeMs:10,maxBlockEndLatencyMs:25},
    preparation:{initializationWallMs:100,wallMs:0,resetWallMs:0,syntheticBlocks:0,decodeCalls:0,newStream:true},
    inference:{decodeCalls:186,firstDecodeWallMs:15,medianDecodeWallMs:25,p95DecodeWallMs:40,maxDecodeWallMs:55,maxBlockWallMs:60,processingWallMs:6000,threadCpuMs:5000,rtf:.1},
    recognition:{rawHits:blocks.length,detections,suppressedHits:blocks.length-detections},
    channels:[0,1].map(channel=>({channel,samples:2880000,rms:.02,peak:.3,clipped:0,nearZero:0})),
    memory:{residentStartBytes:100,residentEndBytes:110,peakResidentBytes:120,residentAfterCleanupBytes:80,residentWindows10s:Array(12).fill(null)},
    cleanup:{microphoneReleased:true,comReleased:true,engineReleased:true,threadsJoined:true,wallMs:1,microphoneReleaseWallMs:1,engineReleaseWallMs:1},
    positions:blocks.map(block=>({block,blockCompleted:true,audioSampleEnd:(block+1)*1600,startTimeSec:0,timestampsSec:[block/10],latencyFromBlockEndMs:25,acousticLatencyMs:null})),details:null};
}
function report(threshold=.25,blocks=hitBlocks):any{
  const r=rawReport(threshold,blocks);return cleanLiveReport(r,{modelHashes,keywordSha256:sha(liveKeyword(threshold))},'COLD','MICROPHONE',60,threshold);
}
function annotations(kind:'VOICE'|'SIMILAR'|'SILENCE'='VOICE'):any{
  return {...annotationTemplate(reportHash,kind),reviewed:true,alignmentConfirmed:true,windows:kind==='SILENCE'?[]:structuredClone(windows)};
}
test('only authorized threshold spellings are accepted; defaults and replay remain compatible',()=>{
  assert.deepEqual(parseLiveFlags([]),{check:false,detail:false,replay:undefined,threshold:.25,thresholdSpecified:false});
  assert.deepEqual(liveConfiguration(),configuration);assert.equal(liveKeyword(),'▁a t la s :1 #0.25 @sherpaw_0');
  for(const text of ['0.25','0.15','0.10','0.1','0.05'])assert.equal(parseLiveFlags(['--threshold',text]).threshold,Number(text));
  for(const text of ['','NaN','Infinity','-0.1','0','1','.15','0.150',' 0.15','0.15 ','1e-1','0.2','0.05x'])assert.throws(()=>parseThreshold(text),/THRESHOLD_INVALID/);
  for(const args of [['--threshold'],['--threshold','0.15','--threshold','0.25'],['--score','2'],['--replay'],['--threshold','0.15','--replay','file.wav']])assert.throws(()=>parseLiveFlags(args));
  assert.equal(parseLiveFlags(['--replay','local.wav','--threshold','0.25']).threshold,.25);
});
test('effective float32 and keyword hash must match the requested threshold; old .25 reports still validate',()=>{
  for(const threshold of [.25,.15,.1,.05]){
    const r=rawReport(threshold),expected={modelHashes,keywordSha256:sha(liveKeyword(threshold))};
    const clean=cleanLiveReport(r,expected,'COLD','MICROPHONE',60,threshold);
    assert.equal(clean.configuration?.threshold,threshold);assert.equal(clean.thresholdEvidence?.spotterArgumentFloat32,Math.fround(threshold));
    const wrong=structuredClone(r);wrong.thresholdEvidence.spotterArgumentFloat32=.3;
    assert.throws(()=>cleanLiveReport(wrong,expected,'COLD','MICROPHONE',60,threshold));
    assert.throws(()=>cleanLiveReport(r,{...expected,keywordSha256:sha(liveKeyword(threshold===.05 ? .25 : .05))},'COLD','MICROPHONE',60,threshold));
  }
  const old=rawReport();delete old.thresholdEvidence;
  assert.equal(cleanLiveReport(old,{modelHashes,keywordSha256:sha(liveKeyword())},'COLD','MICROPHONE',60).configuration?.threshold,.25);
  assert.throws(()=>cleanLiveReport(rawReport(.15),{modelHashes,keywordSha256:sha(liveKeyword(.15))},'COLD','MICROPHONE',60));
});
test('actual C++ parser matches JS values and canonical keyword without Windows or an SDK',async(t)=>{
  if(process.platform!=='linux'){t.skip('C++ portable regression; real MSVC acceptance remains separate');return;}
  const source=await readFile('experiments/wake-word/native-live.cc','utf8');
  const functions=source.slice(source.indexOf('static double ParseLiveThreshold'),source.indexOf('#ifdef _WIN32'));
  const dir=await mkdtemp(join(tmpdir(),'atlas-threshold-'));
  try{
    const file=join(dir,'test.cc'),exe=join(dir,'test');
    await writeFile(file,'#include <cstring>\n#include <string>\nstruct Failure{const char *code;};\n'+functions+
      '\nint main(){if(ParseLiveThreshold("0.10")!=.1||LiveKeyword(.1)!="▁a t la s :1 #0.1 @sherpaw_0")return 1;'+
      ['0.25','0.15','0.1','0.05'].map(v=>`if(ParseLiveThreshold("${v}")!=${v})return 2;`).join('')+
      ['NaN','0.2','1e-1','0.15 ','-0.1',''].map(v=>`try{ParseLiveThreshold("${v}");return 3;}catch(const Failure&){} `).join('')+'return 0;}');
    await promisify(execFile)('g++',['-std=c++17','-Wall','-Wextra','-Werror',file,'-o',exe],{timeout:30000});await promisify(execFile)(exe,[],{timeout:30000});
  }finally{await rm(dir,{recursive:true,force:true});}
  assert.ok(source.indexOf('c.keywords_threshold = static_cast<float>(threshold)')<source.indexOf('Spotter spotter('));
});
test('temporal coverage counts omissions and rejects rawHits/attempts as a substitute',()=>{
  const result=sensitivityTrial(report(.15,hitBlocks.slice(0,18)),annotations(),reportHash);
  assert.equal(result.associatedPronunciations,18);assert.equal(result.omittedPronunciations,2);assert.equal(result.sensitivityEstimate,.9);assert.equal(result.meetsTrialCriteria,true);
  const noisy=sensitivityTrial(report(.15,[0,...hitBlocks]),annotations(),reportHash);
  assert.equal(noisy.rawHits,21);assert.equal(noisy.suppressedHits,1);assert.equal(noisy.associatedPronunciations,19);assert.equal(noisy.omittedPronunciations,1);
  assert.equal(noisy.rawFalsePositives,1);assert.equal(noisy.meetsTrialCriteria,false);
});
test('duplicates, cooldown suppression, decoder margin and ambiguous windows are distinguished',()=>{
  const duplicated=sensitivityTrial(report(.1,[7,8,17,...hitBlocks.slice(1)]),annotations(),reportHash);
  assert.equal(duplicated.duplicateDetections,1);assert.equal(duplicated.rawDuplicateHits,2);assert.equal(duplicated.suppressedHits,1);assert.equal(duplicated.meetsTrialCriteria,false);
  const delayed=sensitivityTrial(report(.1,[18,...hitBlocks.slice(1)]),annotations(),reportHash); // 1900 ms = fixed upper boundary.
  assert.equal(delayed.associatedPronunciations,20);assert.deepEqual(delayed.margin,matchingMargin);
  const a=annotations();a.windows[1]={id:2,startMs:1500,endMs:1800};
  const ambiguous=sensitivityTrial(report(.1,[16]),a,reportHash);
  assert.equal(ambiguous.state,'NEEDS_REVIEW');assert.equal(ambiguous.sensitivityEstimate,null);assert.equal(ambiguous.meetsTrialCriteria,false);
});
test('all hits in silence/similar-word controls are false positives, even if suppressed',()=>{
  for(const kind of ['SILENCE','SIMILAR'] as const){
    const quiet=sensitivityTrial(report(.05,[]),annotations(kind),reportHash);assert.equal(quiet.rawFalsePositives,0);assert.equal(quiet.meetsTrialCriteria,true);assert.equal(quiet.sensitivityEstimate,null);
    const noisy=sensitivityTrial(report(.05,[7,8]),annotations(kind),reportHash);assert.equal(noisy.rawFalsePositives,2);assert.equal(noisy.falsePositives,1);assert.equal(noisy.meetsTrialCriteria,false);
  }
});
test('unreviewed, shifted, mismatched or private annotations and inconsistent reports fail closed',()=>{
  const mutations=[(a:any)=>a.reviewed=false,(a:any)=>a.alignmentConfirmed=false,(a:any)=>a.reportSha256=sha('different'),
    (a:any)=>a.windows[0].startMs=-1,(a:any)=>a.windows[0].endMs=61000,(a:any)=>a.windows[0].endMs=0,
    (a:any)=>a.windows[0].transcript='PRIVATE_SPEECH',(a:any)=>a.deviceName='PRIVATE_DEVICE'];
  for(const mutate of mutations){const a=annotations();mutate(a);assert.throws(()=>sensitivityTrial(report(),a,reportHash));}
  const broken=report();broken.positions.pop();
  assert.throws(()=>sensitivityTrial(broken,annotations(),reportHash),/HIT_ACCOUNTING_INVALID/);
  const failure=sensitivityTrial({state:'FAILED',private:'PRIVATE'},null,reportHash);assert.equal(failure.state,'EXCLUDED');assert.doesNotMatch(JSON.stringify(failure),/PRIVATE/);
  const slow=report();slow.inference.maxBlockWallMs=220;
  assert.equal(sensitivityTrial(slow,annotations(),reportHash).meetsTrialCriteria,false);
});

test('manual annotation stopwatch requires explicit alignment and paired windows, without storing utterances',()=>{
  let now=1000;const recorder=new ManualWindows('VOICE',()=>now);
  assert.throws(()=>recorder.command('b'));recorder.command('start');now=1500;recorder.command('b');
  assert.throws(()=>recorder.command('confirm'));now=1900;recorder.command('e');
  const result=recorder.command('confirm');assert.deepEqual(result,{complete:true,windows:[{id:1,startMs:500,endMs:900}]});
  assert.throws(()=>recorder.command('start'));
  const silence=new ManualWindows('SILENCE',()=>now);silence.command('start');assert.throws(()=>silence.command('b'));
  assert.deepEqual(silence.command('confirm').windows,[]);
});

test('annotation CLI binds a new local JSON report after numeric keyboard events, with no source content in output',async()=>{
  await mkdir('.local',{recursive:true});const dir=await mkdtemp('.local/sensitivity-annotation-');
  const file=join(dir,'trial.json'),data=JSON.stringify({...report(),private:'PRIVATE_SOURCE'});
  const child=spawn(process.execPath,['--import','tsx','experiments/wake-word/native-sensitivity.ts','annotate',file,'VOICE'],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b.toString();});
  try{
    await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('ANNOTATOR_READY_TIMEOUT')),10000);
      child.on('error',reject);child.stderr.on('data',b=>{stderr+=b.toString();if(stderr.includes('En otro terminal')){clearTimeout(timer);done();}});});
    await writeFile(file,data);child.stdin.write('start\nb\n');await new Promise(done=>setTimeout(done,15));child.stdin.end('e\nconfirm\n');
    const code=await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('ANNOTATOR_CLOSE_TIMEOUT'));},10000);child.once('close',value=>{clearTimeout(timer);done(value);});});
    assert.equal(code,0);const result=JSON.parse(stdout);assert.equal(result.reportSha256,sha(data));assert.equal(result.attempts,1);
    assert.equal(result.reviewed,true);assert.equal(result.alignmentConfirmed,true);assert.equal(result.windows.length,1);
    assert.doesNotMatch(stdout+stderr,/PRIVATE_SOURCE/);
  }finally{if(child.exitCode===null)child.kill();await rm(dir,{recursive:true,force:true});}
});
