import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha,sdkHashes } from './benchmark-contract.js';
import { liveKeyword,liveConfiguration,parseLiveFlags } from './native-live-config.js';
import { auditCalibrationEvidence,auditCalibrationIndex,calibrationDesign } from './native-calibration.js';

const source=(id:'A1'|'A2',value:any)=>{const bytes=Buffer.from(JSON.stringify(value));return {id,sha256:sha(bytes),bytes};};
function cancelledReport(trialId:string):any{
  const zero=(names:string)=>Object.fromEntries(names.split(' ').map(k=>[k,0]));
  return {schema:1,backend:'NATIVE_LIVE',source:'MICROPHONE',state:'CANCELLED',code:'CAPTURE_INCOMPLETE',mode:'COLD',configuration:liveConfiguration(.15),
    thresholdEvidence:{spotterArgumentFloat32:Math.fround(.15)},runtime:{version:'2.0.0',dllHashes:sdkHashes},
    modelHashes:Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(k=>[k,sha(k)])),keywordSha256:sha(liveKeyword(.15)),
    format:{rate:48000,channels:1,containerBits:16,validBits:16,selectedChannel:0,endpointBufferFrames:480,kind:'PCM16'},
    capture:{...zero('wallMs framesReceived framesConverted unconvertedFrames resampledSamples enqueuedBlocks processedSamples processedBlocks silentFrames unprocessedSamples overflows discontinuities initialDiscontinuities sequenceErrors'),requestedSeconds:60},
    buffer:{...zero('highWater pendingAfterCleanup abandonedBlocksOnFailure maxQueueAgeMs maxBlockEndLatencyMs'),queuedCapacity:4,decoderBlocks:1,assemblerBlocks:1},
    preparation:{...zero('initializationWallMs wallMs resetWallMs syntheticBlocks decodeCalls'),newStream:false},
    inference:zero('decodeCalls firstDecodeWallMs medianDecodeWallMs p95DecodeWallMs maxDecodeWallMs maxBlockWallMs processingWallMs threadCpuMs rtf'),
    recognition:{rawHits:0,detections:0,suppressedHits:0},channels:[{channel:0,samples:0,rms:0,peak:0,clipped:0,nearZero:0}],
    memory:{...zero('residentStartBytes residentEndBytes peakResidentBytes residentAfterCleanupBytes'),residentWindows10s:Array(12).fill(null)},
    conversion:{...zero('outputRms outputPeak outputClipped appendedSamples'),outputRate:16000,firTaps:385,filterDelayMs:4},
    cleanup:{wallMs:0,microphoneReleaseWallMs:0,engineReleaseWallMs:0,microphoneReleased:true,comReleased:true,engineReleased:true,threadsJoined:true},
    wavSha256:null,pcmSha256:null,processedPcmSha256:null,
    positions:[],details:null,fnDiagnostics:{schema:1,trialId,clock:'QPC_RELATIVE_MS',signalDomain:'POST_FIR_MONO_16000',channelHealthy:true,blocks:[],decodes:[],markers:[],hostMarkers:[]}};
}
test('design is deterministic, has nine independent trials and preserves both threshold authorities',()=>{
  const a=calibrationDesign();assert.deepEqual(a,calibrationDesign());assert.equal(a.state,'IMPLEMENTED_WINDOWS_ACCEPTANCE_PENDING');
  assert.equal(a.protocol.trials.length,9);assert.equal(a.protocol.recordingImplemented,true);
  assert.equal(a.protocol.qpcToPcmConversionImplemented,true);assert.equal(a.protocol.paddingSamples,0);
  assert.deepEqual(a.protocol.margin,{beforeMs:250,afterMs:1000});
  for(const row of a.protocol.trials){assert.deepEqual(row.configuration,liveConfiguration(row.configuration.threshold));
    assert.equal(row.keywordSha256,sha(liveKeyword(row.configuration.threshold)));
    assert.equal(row.spotterThresholdFloat32,Math.fround(row.configuration.threshold));assert.equal(row.existingReplaySupported,false);}
  assert.equal(new Set(a.protocol.trials.slice(0,3).map(r=>r.keywordSha256)).size,3);
});
test('historical replay restrictions stay fail-closed for the requested sweep',()=>{
  for(const t of ['0.15','0.10','0.05'])assert.throws(()=>parseLiveFlags(['--replay','private.wav','--threshold',t]),{message:'REPLAY_THRESHOLD_UNSUPPORTED'});
  for(const t of ['0','0.2','NaN','1e-1'])assert.throws(()=>parseLiveFlags(['--threshold',t]));
  assert.equal(parseLiveFlags(['--replay','private.wav']).threshold,.25);
});
test('audit is reproducible and cannot turn historical rawHits into associated successes',()=>{
  const a=source('A1',{recognition:{rawHits:15},private:'DO_NOT_LOG'}),b=source('A2',{recognition:{rawHits:20}});
  const report=auditCalibrationEvidence([a,b]);assert.deepEqual(report,auditCalibrationEvidence([b,a]));
  assert.equal(report.state,'AUDITED_NOT_CALIBRATED');assert.equal(report.betweenLiveSessions,null);
  assert.ok(report.evidence.every(r=>r.state==='NOT_EVALUABLE'&&r.associatedPronunciations===null&&r.rawHits===null));
  assert.doesNotMatch(JSON.stringify(report),/DO_NOT_LOG|"pcm"|transcript|private\.wav/);
});
test('byte hashes, distinct evidence and valid JSON are mandatory without retries',()=>{
  const a=source('A1',{state:'COMPLETED'});
  assert.throws(()=>auditCalibrationEvidence([{...a,sha256:'0'.repeat(64)}]),{message:'CALIBRATION_HASH_MISMATCH'});
  assert.throws(()=>auditCalibrationEvidence([a,{...a,id:'A2'}]),{message:'CALIBRATION_DUPLICATE_EVIDENCE'});
  assert.throws(()=>auditCalibrationEvidence([a,a]));assert.throws(()=>auditCalibrationEvidence([]));
  const bad=Buffer.from('not JSON PRIVATE');assert.throws(()=>auditCalibrationEvidence([{id:'A1',sha256:sha(bad),bytes:bad}]),{message:'CALIBRATION_EVIDENCE_INVALID'});
  assert.throws(()=>auditCalibrationEvidence([source('A1',{fnDiagnostics:{schema:1},recognition:{rawHits:20}})]),{message:'CALIBRATION_EVIDENCE_INVALID'});
});
test('valid diagnostic reports are revalidated; cancelled trials, reused trials and inconsistent results never become calibration successes',()=>{
  const a=cancelledReport('a'.repeat(32)),b=cancelledReport('b'.repeat(32));
  const audit=auditCalibrationEvidence([source('A1',a),source('A2',b)]);
  assert.equal(audit.evidence[0]!.state,'DIAGNOSED');assert.equal(audit.evidence[0]!.sensitivityEstimate,null);
  assert.equal(audit.evidence[0]!.evaluableAttempts,0);assert.equal(audit.evidence[0]!.rawHits,0);
  assert.equal(audit.betweenLiveSessions.sensitivityInterpretable,false);assert.equal(audit.sameAudioEvidence,'NOT_PROVEN_LIVE_CAPTURES_ARE_NOT_REPLAY');
  assert.deepEqual(audit,auditCalibrationEvidence([source('A1',a),source('A2',b)]));
  b.capture.wallMs=1;b.fnDiagnostics.trialId=a.fnDiagnostics.trialId;
  assert.throws(()=>auditCalibrationEvidence([source('A1',a),source('A2',b)]),{message:'CALIBRATION_DUPLICATE_EVIDENCE'});
  b.fnDiagnostics.trialId='b'.repeat(32);b.configuration.score=2;
  assert.throws(()=>auditCalibrationEvidence([source('A2',b)]),{message:'CALIBRATION_EVIDENCE_INVALID'});
  a.recognition.rawHits=15;assert.throws(()=>auditCalibrationEvidence([source('A1',a)]),{message:'CALIBRATION_EVIDENCE_INVALID'});
});
test('index is metadata only, strictly validated, hash-bound and contained in ignored local storage',async()=>{
  await mkdir('.local',{recursive:true});const dir=await mkdtemp(join('.local','calibration-test-')),outside=await mkdtemp(join(tmpdir(),'calibration-out-'));
  try{const a=source('A1',{schema:1}),path=join(dir,'report.json'),index=join(dir,'index.json');await writeFile(path,a.bytes);
    const descriptor={schema:1,reports:[{id:'A1',path,sha256:a.sha256}]};
    await writeFile(index,JSON.stringify(descriptor));assert.equal((await auditCalibrationIndex(index)).evidence.length,1);
    await writeFile(path,JSON.stringify({schema:2}));await assert.rejects(auditCalibrationIndex(index),{message:'CALIBRATION_HASH_MISMATCH'});
    descriptor.reports[0]!.path=join(outside,'report.json');await writeFile(descriptor.reports[0]!.path,a.bytes);await writeFile(index,JSON.stringify(descriptor));
    await assert.rejects(auditCalibrationIndex(index),{message:'LOCAL_PATH_REQUIRED'});
    await writeFile(index,JSON.stringify({...descriptor,pcm:'REJECTED'}));await assert.rejects(auditCalibrationIndex(index),{message:'CALIBRATION_INPUT_INVALID'});
  }finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('implementation has no audio access, engine execution, persistence or implicit consent',async()=>{
  const code=await readFile(new URL('./native-calibration.ts',import.meta.url),'utf8');
  assert.doesNotMatch(code,/child_process|decodeWav|writeFile|appendFile|createWriteStream|getUserMedia|SherpaOnnx|\.wav['"]/);
  const before=Buffer.from('{"schema":1}');const copy=Buffer.from(before);auditCalibrationEvidence([{id:'A1',sha256:sha(before),bytes:before}]);assert.deepEqual(before,copy);
});
