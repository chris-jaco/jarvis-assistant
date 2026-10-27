// Calibration-only numeric contract. Never records or reconstructs audio.
import { sha,sdkHashes } from './benchmark-contract.js';
import { cleanLiveReport } from './native-live.js';
import { validateFnDiagnostics } from './native-fn-diagnostics.js';
import { CalibrationAlignmentError,inspectCalibrationAlignment } from './calibration-alignment.js';
import { liveKeyword } from './native-live-config.js';
import type { ReplayStage } from './replay-observation.js';
import { cleanReplayTiming,type ReplayTimingMode } from './replay-authorization.js';
import { SpikeError } from './core.js';
export const calibrationThresholds=[.15,.10,.05] as const;
import { calibrationMaxSamples } from './calibration-limits.js';
export { shortCalibrationSamples,maxCalibrationSamples,longCalibrationSamples,calibrationMaxSamples } from './calibration-limits.js';
export const retentionMs=7*24*60*60*1000;
export const calibrationFormat={encoding:'F32LE',sampleRate:16000,channels:1,blockSamples:1600,domain:'POST_FIR',paddingSamples:0,normalization:false} as const;
export type Kind='POSITIVE'|'SILENCE'|'SIMILAR';
export const fail=(code:string):never=>{throw new SpikeError(code);};
export const digest=(v:any)=>sha(JSON.stringify(v));
export const same=(a:any,b:any)=>digest(a)===digest(b);
export function checkedKind(v:string):Kind{if(!['POSITIVE','SILENCE','SIMILAR'].includes(v))fail('CAL_KIND_INVALID');return v as Kind;}
export function captureSeconds(kind:Kind){return checkedKind(kind)==='SILENCE'?60:180;}
// Missing duration identifies the already published 60-second calibration contract.
export function sessionSeconds(session:any){
  const kind=checkedKind(session.kind),seconds=session.requestedSeconds===undefined?60:session.requestedSeconds;
  if(seconds!==60&&!((seconds===120||seconds===180)&&kind!=='SILENCE'))fail('CAL_DURATION_INVALID');return seconds as number;
}
export function replaySeconds(session:any){
  const seconds=sessionSeconds(session);
  if(!Number.isSafeInteger(session.samples)||session.samples<1||session.samples>calibrationMaxSamples(seconds))fail('CAL_PCM_LENGTH_INVALID');
  return Math.max(seconds,Math.ceil(session.samples/16000));
}
export function validateCalCapture(report:any,kind:Kind,seconds:number){
  sessionSeconds({kind,requestedSeconds:seconds});
  if(report?.runtime?.version!=='2.0.0'||JSON.stringify(Object.entries(report.runtime.dllHashes??{}).sort())!==JSON.stringify(Object.entries(sdkHashes).sort())
    ||!report.modelHashes||Object.keys(report.modelHashes).length!==4||!/^[a-f0-9]{32}$/.test(report.fnDiagnostics?.trialId??'')
    ||!Array.isArray(report.fnDiagnostics?.hostMarkers))fail('CAL_SESSION_INVALID');
  for(const name of ['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'])checkHash(report.modelHashes[name]);
  const r=cleanLiveReport({...report,runtime:{version:'2.0.0',dlls:['sherpa-onnx-c-api.dll','onnxruntime.dll'].map(name=>({name,sha256:sdkHashes[name]}))}},
    {modelHashes:report.modelHashes,keywordSha256:sha(liveKeyword(.15))},'COLD','MICROPHONE',seconds,.15,
    {trialId:report.fnDiagnostics?.trialId,host:report.fnDiagnostics?.hostMarkers});
  replaySeconds({kind,requestedSeconds:seconds,samples:r.capture.processedSamples});
  // Preserve the Hito 1.5 hit/cooldown accounting without relaxing its 60 s entry point.
  if(r.positions.length!==r.recognition.rawHits)fail('CAL_HIT_ACCOUNTING_INVALID');
  let last=-Infinity,previous=-1,accepted=0;
  for(const p of r.positions){
    if(!Number.isSafeInteger(p.block)||p.block<previous)fail('CAL_HIT_ACCOUNTING_INVALID');previous=p.block;
    if(p.block*100-last>=1000){last=p.block*100;accepted++;}
  }
  if(accepted!==r.recognition.detections||r.positions.length-accepted!==r.recognition.suppressedHits)fail('CAL_HIT_ACCOUNTING_INVALID');
  return r;
}
export function checkHash(v:any){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('CAL_HASH_INVALID');return v as string;}
export function retention(created:string,expires:string,now=Date.now()){
  const c=Date.parse(created),e=Date.parse(expires);
  if(!Number.isFinite(c)||!Number.isFinite(e)||new Date(c).toISOString()!==created||new Date(e).toISOString()!==expires||e-c!==retentionMs||c>now)fail('CAL_RETENTION_INVALID');
  return now>=e?'EXPIRED':'WITHIN_RETENTION';
}
export function validatePcm(bytes:Uint8Array,expected:string,samples:number,seconds=120){
  checkHash(expected);
  if(!Number.isSafeInteger(samples)||samples<1||samples>calibrationMaxSamples(seconds)||bytes.byteLength!==samples*4)fail('CAL_PCM_LENGTH_INVALID');
  if(sha(bytes)!==expected)fail('CAL_PCM_HASH_MISMATCH');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let at=0;at<bytes.byteLength;at+=4)if(!Number.isFinite(view.getFloat32(at,true)))fail('CAL_PCM_INVALID');
}
export function bindCalibrationWindows(report:any,kind:Kind){
  checkedKind(kind);
  sessionSeconds({kind,requestedSeconds:report.capture?.requestedSeconds});
  if(report.state!=='COMPLETED'||report.source!=='MICROPHONE'||report.mode!=='COLD'||report.configuration?.threshold!==.15)fail('CAL_CAPTURE_INCOMPLETE');
  const d=validateFnDiagnostics(report.fnDiagnostics,report,report.fnDiagnostics?.trialId,report.fnDiagnostics?.hostMarkers);
  const result=inspectCalibrationAlignment(report,kind,d);
  if(result.diagnostics.length)throw new CalibrationAlignmentError(result.diagnostics);
  return result.windows;
}
// Cell orchestration must inspect process failure before success-only invariants.
export function validateCalReplayResult(result:{report:any;exitCode:number|null},expected:any,session:any,threshold:number,stage:(value:ReplayStage)=>void=()=>{},timingMode:ReplayTimingMode='STRICT_REALTIME',allowHistoricalTiming=true){
  if(result.exitCode!==0||result.report?.state==='FAILED'||result.report?.state==='CANCELLED')fail('CAL_REPLAY_NATIVE_FAILED');
  return validateCalReplay(result.report,expected,session,threshold,stage,timingMode,allowHistoricalTiming);
}
export function validateCalReplay(raw:any,expected:any,session:any,threshold:number,stage:(value:ReplayStage)=>void=()=>{},timingMode:ReplayTimingMode='STRICT_REALTIME',allowHistoricalTiming=true){
  stage('REPLAY_METADATA');
  if(!calibrationThresholds.some(t=>t===threshold))fail('CAL_THRESHOLD_INVALID');
  const c=raw?.calibration;
  if(c?.schema!==1||c.mode!=='REPLAY'||c.persisted!==false||c.samples!==session.samples||c.sha256!==session.pcmSha256)fail('CAL_REPLAY_CONTRACT_INVALID');
  const replayTiming=cleanReplayTiming(raw.replayTiming,timingMode,allowHistoricalTiming);
  if(raw.state==='COMPLETED'&&replayTiming.cancelled===true)fail('CAL_REPLAY_CONTRACT_INVALID');
  stage('SESSION_LIMITS');replaySeconds(session);
  stage('REPORT_VALIDATION');
  const r=cleanLiveReport(raw,{...expected,wavSha256:null,pcmSha256:session.pcmSha256},'COLD','REPLAY',sessionSeconds(session),threshold);
  stage('REPLAY_ACCOUNTING');
  if(r.state!=='COMPLETED'||r.capture.processedSamples!==session.samples||r.capture.processedBlocks!==Math.ceil(session.samples/1600)
    ||r.format.kind!=='FLOAT32'||r.format.rate!==16000||r.format.channels!==1||r.conversion.firTaps!==1||r.conversion.filterDelayMs!==0
    ||!same(r.modelHashes,session.modelHashes)||!r.details||r.details.blocks.length!==r.capture.processedBlocks
    ||r.positions.length!==r.recognition.rawHits||r.details.decodes.length!==r.inference.decodeCalls)fail('CAL_REPLAY_CONTRACT_INVALID');
  stage('BLOCK_DETAILS');
  for(let i=0;i<r.details.blocks.length;i++){
    const b=r.details.blocks[i];if(b.sequence!==i||b.decodeCalls!==r.details.decodes.filter((d:any)=>d.block===i).length
      ||b.rawHits!==r.positions.filter((p:any)=>p.block===i).length||typeof b.wallMs!=='number')fail('CAL_REPLAY_CONTRACT_INVALID');
  }
  stage('DECODE_DETAILS');
  let decoded=-1;for(const d of r.details.decodes){if(!Number.isSafeInteger(d.block)||d.block<decoded||d.block<0||d.block>=r.capture.processedBlocks||typeof d.wallMs!=='number')fail('CAL_REPLAY_CONTRACT_INVALID');decoded=d.block;}
  stage('HIT_POSITIONS');
  let previous=-1;for(const p of r.positions){if(!Number.isInteger(p.block)||p.block<previous||p.block<0||!p.blockCompleted
    ||p.block>=r.capture.processedBlocks||p.audioSampleEnd!==Math.min(session.samples,(p.block+1)*1600))fail('CAL_REPLAY_CONTRACT_INVALID');previous=p.block;}
  return {...r,replayTiming};
}
export function associateCalibration(r:any,session:any){
  const target=session.kind==='POSITIVE',windows=session.windows.map((w:any)=>({...w,accepted:0,raw:0}));
  const events:any[]=[];let last=-Infinity,accepted=0,suppressed=0,rawOutside=0,outside=0;
  for(const p of r.positions){
    const take=p.block*100-last>=1000;if(take){last=p.block*100;accepted++;}else suppressed++;
    const possible=windows.filter((w:any)=>p.audioSampleEnd>=w.begin.lower-4000&&p.audioSampleEnd<=w.end.upper+16000);
    const w=possible.length===1?possible[0]:undefined;
    if(possible.length>1||(w&&(p.audioSampleEnd<w.begin.upper-4000||p.audioSampleEnd>w.end.lower+16000)))fail('CAL_HIT_AMBIGUOUS');
    if(w){w.raw++;if(take)w.accepted++;}else{rawOutside++;if(take)outside++;}
    events.push({block:p.block,audioSampleEnd:p.audioSampleEnd,accepted:take,windowId:w?.id??null,
      audioEndDifferenceMs:w?{lower:(p.audioSampleEnd-w.end.upper)/16,upper:(p.audioSampleEnd-w.end.lower)/16}:null,
      deliveryFromBlockEndMs:p.latencyFromBlockEndMs,acousticLatencyMs:null});
  }
  if(accepted!==r.recognition.detections||suppressed!==r.recognition.suppressedHits)fail('CAL_HIT_ACCOUNTING_INVALID');
  const matched=target?windows.filter((w:any)=>w.accepted>0).length:null;
  return {kind:session.kind,threshold:r.configuration.threshold,rawHits:r.positions.length,detections:accepted,suppressedHits:suppressed,
    associatedPronunciations:matched,omissions:target?20-matched!:null,sensitivity:target?matched!/20:null,
    duplicates:target?windows.reduce((s:number,w:any)=>s+Math.max(0,w.accepted-1),0):0,
    falsePositives:target?outside:accepted,rawFalsePositives:target?rawOutside:r.positions.length,
    falsePositivesPerHour:(target?outside:accepted)*16000*3600/session.samples,events,
    recognitionSignature:digest({samples:session.samples,pcmSha256:session.pcmSha256,annotationSha256:session.annotationSha256,
      modelHashes:r.modelHashes,configuration:r.configuration,keywordSha256:r.keywordSha256,
      recognition:r.recognition,positions:r.positions.map((p:any)=>({block:p.block,sampleEnd:p.audioSampleEnd,start:p.startTimeSec,timestamps:p.timestampsSec})),
      decodeBlocks:r.details.decodes.map((d:any)=>d.block)}),
    performance:r.inference,buffer:r.buffer,memory:r.memory,cleanup:r.cleanup};
}
