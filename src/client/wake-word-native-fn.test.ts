import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeMarkers,validateFnDiagnostics } from '../../experiments/wake-word/native-fn-diagnostics.js';
import { falseNegativeReport,compareFnSessions } from '../../experiments/wake-word/native-fn.js';
import { liveConfiguration,liveKeyword } from '../../experiments/wake-word/native-live-config.js';
import { sdkHashes,sha } from '../../experiments/wake-word/benchmark-contract.js';
import { runLiveChild } from '../../experiments/wake-word/native-live.js';
import { EventEmitter } from 'node:events';

const nonce='a'.repeat(32);
function fixture():any{
  const markers=Array.from({length:40},(_,i)=>({id:i+1,kind:i%2?'E':'B',qpcMs:2000+Math.floor(i/2)*2500+(i%2?600:0)}));
  const blocks=Array.from({length:600},(_,i)=>({sequence:i,sampleStart:i*1600,sampleEnd:(i+1)*1600,samples:1600,qpcStartMs:1000+i*100,qpcEndMs:1100+i*100,
    sumSquares:.16,rms:.01,peak:.01,nearZero:0,clipped:0,invalid:0,metricsWallMs:.01,completed:true,decodeCalls:1,rawHits:i===12?1:0}));
  return {schema:1,backend:'NATIVE_LIVE',source:'MICROPHONE',state:'COMPLETED',code:'CAPTURE_COMPLETED',mode:'COLD',configuration:liveConfiguration(.15),
    thresholdEvidence:{spotterArgumentFloat32:Math.fround(.15)},runtime:{version:'2.0.0',dllHashes:sdkHashes},
    modelHashes:{'encoder.onnx':sha('encoder'),'decoder.onnx':sha('decoder'),'joiner.onnx':sha('joiner'),'tokens.txt':sha('tokens')},keywordSha256:sha(liveKeyword(.15)),
    wavSha256:null,pcmSha256:null,processedPcmSha256:null,format:{rate:48000,channels:2,containerBits:32,validBits:32,kind:'FLOAT32',selectedChannel:0,endpointBufferFrames:480},
    conversion:{outputRate:16000,firTaps:385,filterDelayMs:4,outputRms:.01,outputPeak:.01,outputClipped:0,appendedSamples:0},
    capture:{requestedSeconds:60,wallMs:60001,framesReceived:2880000,framesConverted:2880000,unconvertedFrames:0,resampledSamples:960000,enqueuedBlocks:600,processedSamples:960000,processedBlocks:600,
      silentFrames:0,unprocessedSamples:0,overflows:0,discontinuities:0,initialDiscontinuities:1,sequenceErrors:0},
    buffer:{queuedCapacity:4,decoderBlocks:1,assemblerBlocks:1,highWater:2,pendingAfterCleanup:0,abandonedBlocksOnFailure:0,maxQueueAgeMs:10,maxBlockEndLatencyMs:30},
    preparation:{initializationWallMs:100,wallMs:0,resetWallMs:0,syntheticBlocks:0,decodeCalls:0,newStream:true},
    inference:{decodeCalls:600,firstDecodeWallMs:10,medianDecodeWallMs:10,p95DecodeWallMs:20,maxDecodeWallMs:25,maxBlockWallMs:30,processingWallMs:6000,threadCpuMs:5000,rtf:.1},
    recognition:{rawHits:1,detections:1,suppressedHits:0},channels:[0,1].map(channel=>({channel,samples:2880000,rms:.01,peak:.01,clipped:0,nearZero:0})),
    memory:{residentStartBytes:100,residentEndBytes:110,peakResidentBytes:120,residentAfterCleanupBytes:90,residentWindows10s:Array(12).fill(null)},
    cleanup:{microphoneReleased:true,comReleased:true,engineReleased:true,threadsJoined:true,wallMs:1,microphoneReleaseWallMs:1,engineReleaseWallMs:1},
    positions:[{block:12,blockCompleted:true,audioSampleEnd:20800,startTimeSec:0,timestampsSec:[1],latencyFromBlockEndMs:25,acousticLatencyMs:null}],details:null,
    fnDiagnostics:{schema:1,trialId:nonce,clock:'QPC_RELATIVE_MS',signalDomain:'POST_FIR_MONO_16000',channelHealthy:true,blocks,
      decodes:blocks.map(b=>({block:b.sequence,startMs:b.qpcEndMs+5,endMs:b.qpcEndMs+15})),markers,
      hostMarkers:markers.map(m=>({...m,acknowledged:true,roundTripMs:10}))}};
}
test('QPC/ACK synchronization rejects nonce mismatch, duplicates and invalid ordering; high RTT remains observable',()=>{
  let now=10;const frames:string[]=[];const session=new NativeMarkers(nonce,()=>now);session.attach(value=>frames.push(value));
  assert.equal(session.mark('B'),false);session.stage('CAPTURE_STARTED');assert.equal(session.mark('E'),false);assert.equal(session.mark('B'),true);
  assert.equal(session.mark('B'),false);now=25;assert.equal(session.ack(`ACK ${nonce} 1 B 2000`).alignmentUsable,true);
  assert.throws(()=>session.ack(`ACK ${nonce} 1 B 2000`));assert.equal(session.mark('E'),true);now=125;
  assert.equal(session.ack(`ACK ${nonce} 2 E 2600`).alignmentUsable,false);session.close();assert.equal(session.mark('B'),false);
  const other=new NativeMarkers(nonce,()=>now);other.attach(()=>{});other.stage('CAPTURE_STARTED');other.mark('B');
  assert.throws(()=>other.ack(`ACK ${'b'.repeat(32)} 1 B 1`));assert.equal(frames.length,2);
  const broken=new NativeMarkers(nonce);broken.attach(()=>{throw Error('PRIVATE_PIPE_DETAIL');});broken.stage('CAPTURE_STARTED');
  assert.throws(()=>broken.mark('B'),{message:'FN_DIAGNOSTICS_INVALID'});assert.equal(broken.mark('B'),false);
});
test('old reports are explicitly not evaluable; numerical contract rejects corrupt metrics and private payloads are stripped',()=>{
  assert.equal(falseNegativeReport({state:'COMPLETED'}).state,'NOT_EVALUABLE');
  const r=fixture(),d=r.fnDiagnostics;d.private='PRIVATE';d.blocks[0].pcm='PRIVATE_PCM';d.hostMarkers[0].transcript='PRIVATE_TEXT';
  const clean=validateFnDiagnostics(d,r,nonce,d.hostMarkers);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE/);
  for(const mutate of [(x:any)=>x.blocks[0].sumSquares=3,(x:any)=>x.markers[1].id=1,(x:any)=>x.decodes[0].endMs=-1,(x:any)=>x.hostMarkers[0].qpcMs++]){
    const x=fixture();mutate(x.fnDiagnostics);assert.throws(()=>validateFnDiagnostics(x.fnDiagnostics,x,nonce,x.fnDiagnostics.hostMarkers));
  }
});
test('per-attempt report distinguishes matched, valid PCM miss, low signal and duplicates without inferring a model cause',()=>{
  const r=fixture();for(const b of r.fnDiagnostics.blocks)if(b.qpcStartMs>=9400&&b.qpcEndMs<=10200){b.sumSquares=.0016;b.rms=.001;b.peak=.001;}
  const result=falseNegativeReport(r);assert.equal(result.attempts[0].category,'MATCHED');assert.equal(result.attempts[1].category,'MISSED_WITH_VALID_AUDIO');
  assert.equal(result.attempts[3].category,'MISSED_LOW_SIGNAL');assert.equal(result.sensitivityEstimate,.05);
  assert.equal(result.attempts[1].signal.domain,'POST_FIR_MONO_16000');assert.equal(result.rawSignalContext.domain,'PRE_FIR_SESSION_ONLY');
  r.positions.push({...r.positions[0],block:22,audioSampleEnd:36800});r.recognition.rawHits=2;r.recognition.detections=2;r.fnDiagnostics.blocks[22].rawHits=1;
  // Widen only the manually marked first window to include a duplicate one second later.
  r.fnDiagnostics.markers[1].qpcMs=3200;r.fnDiagnostics.hostMarkers[1].qpcMs=3200;
  const dup=falseNegativeReport(r);assert.equal(dup.attempts[0].category,'MATCHED');assert.equal(dup.duplicates,1);
});
test('uncertainty, shared windows, sub-block energy and clipping produce AMBIGUOUS; outside hits remain false positives',()=>{
  const late=fixture();late.fnDiagnostics.hostMarkers[0].roundTripMs=90;
  assert.equal(falseNegativeReport(late).attempts[0].category,'AMBIGUOUS');
  const overlap=fixture();overlap.fnDiagnostics.markers[2].qpcMs=3000;overlap.fnDiagnostics.hostMarkers[2].qpcMs=3000;
  const a=falseNegativeReport(overlap);assert.equal(a.attempts[0].category,'AMBIGUOUS');assert.equal(a.attempts[1].category,'AMBIGUOUS');assert.equal(a.sensitivityEstimate,null);
  const clipping=fixture();Object.assign(clipping.fnDiagnostics.blocks[36],{clipped:1,peak:1,sumSquares:1.16,rms:Math.sqrt(1.16/1600)});
  assert.equal(falseNegativeReport(clipping).attempts[1].category,'AMBIGUOUS');
  const outside=fixture();outside.positions[0].block=0;outside.positions[0].audioSampleEnd=1600;outside.fnDiagnostics.blocks[12].rawHits=0;outside.fnDiagnostics.blocks[0].rawHits=1;
  assert.equal(falseNegativeReport(outside).falsePositives,1);
});
test('incomplete captures and local coverage failure are never converted to complete sensitivity',()=>{
  const r=fixture();r.state='CANCELLED';r.code='CAPTURE_INCOMPLETE';r.capture.wallMs=10000;
  r.capture.processedSamples=160000;r.capture.processedBlocks=100;r.capture.framesReceived=480000;r.capture.framesConverted=480000;r.capture.resampledSamples=160000;r.capture.enqueuedBlocks=100;
  r.fnDiagnostics.blocks=r.fnDiagnostics.blocks.slice(0,100);r.fnDiagnostics.decodes=r.fnDiagnostics.decodes.slice(0,100);r.inference.decodeCalls=100;
  const result=falseNegativeReport(r);assert.equal(result.trialComplete,false);assert.equal(result.sensitivityEstimate,null);
  assert.equal(result.attempts[19].category,'MISSED_CAPTURE_ISSUE');
  const missing=fixture();missing.fnDiagnostics.hostMarkers=[];assert.equal(falseNegativeReport(missing).counts.AMBIGUOUS,20);
});
test('session comparison requires distinct trials and identical model/configuration identities',()=>{
  const a=falseNegativeReport(fixture()),r=fixture();r.fnDiagnostics.trialId='b'.repeat(32);const b=falseNegativeReport(r);
  assert.equal(compareFnSessions(a,b).matchedDifference,0);assert.throws(()=>compareFnSessions(a,a));
  b.format.rate=44100;assert.throws(()=>compareFnSessions(a,b));
});
test('partial block energy and QPC discontinuities cannot establish accurate windows',()=>{
  const partial=fixture();partial.fnDiagnostics.markers[3].qpcMs=4550;partial.fnDiagnostics.hostMarkers[3].qpcMs=4550;
  const p=falseNegativeReport(partial);assert.equal(p.attempts[1].category,'AMBIGUOUS');assert.equal(p.attempts[1].reason,'SUB_BLOCK_WINDOW');
  const jump=fixture();for(const b of jump.fnDiagnostics.blocks.slice(36)){b.qpcStartMs-=3;b.qpcEndMs-=3;}
  assert.equal(falseNegativeReport(jump).attempts[1].category,'AMBIGUOUS');
  const invalid=fixture(),block=invalid.fnDiagnostics.blocks[36];block.invalid=1;block.sumSquares=.1599;block.rms=Math.sqrt(.1599/1600);
  assert.equal(falseNegativeReport(invalid).attempts[1].category,'MISSED_CAPTURE_ISSUE');
});
test('missing ACK, invalid positions and diagnostics failures cannot authorize sensitivity interpretation',()=>{
  const missing=fixture();missing.fnDiagnostics.hostMarkers=missing.fnDiagnostics.hostMarkers.slice(0,1);
  assert.equal(falseNegativeReport(missing).sensitivityEstimate,null);
  const position=fixture();position.positions[0].audioSampleEnd++;assert.throws(()=>falseNegativeReport(position));
  const failed=fixture();failed.state='FAILED';failed.code='DIAGNOSTIC_CHANNEL_FAILED';failed.fnDiagnostics.channelHealthy=false;
  const result=falseNegativeReport(failed);assert.equal(result.counts.AMBIGUOUS,20);assert.equal(result.sensitivityEstimate,null);
});
test('real portable C++ diagnostics exercise stalled writer, bounded MPSC, signal metrics and marker parser',async(t)=>{
  if(process.platform!=='linux'){t.skip('Portable compiler regression; Windows capture remains pending');return;}
  const dir=await mkdtemp(join(tmpdir(),'atlas-fn-core-'));
  try{const exe=join(dir,'core');await promisify(execFile)('g++',['-std=c++17','-O2','-pthread','-Wall','-Wextra','-Werror','experiments/wake-word/native-fn-core.test.cc','-o',exe],{timeout:30000});
    const {stdout}=await promisify(execFile)(exe,[],{timeout:30000});assert.equal(JSON.parse(stdout).state,'PASS');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('capture source remains free of marker waits and diagnostic PCM never enters a report',async()=>{
  const source=await readFile('experiments/wake-word/native-live.cc','utf8');const capture=source.slice(source.indexOf('static void Capture('),source.indexOf('static void Replay('));
  assert.doesNotMatch(capture,/marker|diagnosticBlocks|startAsync|messages\./i);
  const asyncWrite=source.slice(source.indexOf('void write(const char *stage)'),source.indexOf('bool finish()'));
  assert.match(asyncWrite,/if\(asynchronous\)\{[^}]+return;\}/);
  assert.match(source,/std::thread\(\[this\]/);assert.match(source,/if\(s.fnEnabled\).*progress.finish/);
  assert.doesNotMatch(JSON.stringify(falseNegativeReport(fixture())),/"pcm"|transcript|embedding|spectrum/i);
});
test('supervisor receives ACK and Stop without overlapping capture instances or late updates',async()=>{
  const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();let writes=0;
  child.stdin.write=(text:string)=>{writes++;if(text==='S')queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('{"state":"CANCELLED"}'));child.emit('close',130);});};child.stdin.destroy=()=>{};child.kill=()=>{};
  const session=new NativeMarkers(nonce),controller=new AbortController();const stages:string[]=[];
  const promise=runLiveChild('owned.exe',[],60,controller.signal,x=>stages.push(x),()=>child,undefined,session);
  child.stderr.emit('data',Buffer.from('CAPTURE_STARTED\n'));assert.equal(session.mark('B'),true);
  child.stderr.emit('data',Buffer.from(`ACK ${nonce} 1 B 2000\n`));controller.abort();assert.equal((await promise).exitCode,130);
  assert.equal(writes,2);assert.equal(session.mark('E'),false);assert.ok(stages.some(x=>x.startsWith('MARKER_ACK')));
});
