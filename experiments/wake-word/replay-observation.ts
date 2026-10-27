// Supervisor-only, bounded allowlisted diagnostics. Never retain raw reports/PCM.
import { historicalTimingMode } from './replay-authorization.js';
import { SpikeError } from './core.js';
import { nativeDiagnosticCode } from './native-live.js';
export type ReplayStage='DATASET_LOAD'|'PREFLIGHT'|'IDENTITY'|'NATIVE_EXECUTION'|'NATIVE_EXIT'|'REPLAY_METADATA'|'SESSION_LIMITS'|
  'REPORT_VALIDATION'|'REPLAY_ACCOUNTING'|'BLOCK_DETAILS'|'DECODE_DETAILS'|'HIT_POSITIONS'|'DATASET_RECHECK'|'ASSOCIATION';
export interface ReplayCell {kind:'POSITIVE'|'SILENCE'|'SIMILAR';sessionId:string;threshold:number;timingMode?:'STRICT_REALTIME'|'ACOUSTIC_BACKPRESSURE'}
const stages=new Set<ReplayStage>(['DATASET_LOAD','PREFLIGHT','IDENTITY','NATIVE_EXECUTION','NATIVE_EXIT','REPLAY_METADATA','SESSION_LIMITS',
  'REPORT_VALIDATION','REPLAY_ACCOUNTING','BLOCK_DETAILS','DECODE_DETAILS','HIT_POSITIONS','DATASET_RECHECK','ASSOCIATION']);
const knownErrors=new Set(['CAL_AUTHORIZATION_INVALID','CAL_AUTHORIZATION_REQUIRED','CAL_TIMING_MODE_INVALID','CAL_TIMING_MODE_MISMATCH','CAL_REPLAY_NATIVE_FAILED','CAL_REPLAY_CONTRACT_INVALID','CAL_REPLAY_INCOMPLETE','CAL_CANCELLED',
  'CAL_SESSION_CHANGED','CAL_IDENTITY_MISMATCH','CAL_SESSION_INVALID','CAL_RETENTION_EXPIRED','CAL_RETENTION_INVALID','CAL_CONSENT_INVALID',
  'CAL_JSON_INVALID','CAL_PATH_INVALID','CAL_HASH_INVALID','CAL_PCM_HASH_MISMATCH','CAL_PCM_LENGTH_INVALID','CAL_PCM_INVALID',
  'CAL_REPORT_HASH_MISMATCH','CAL_ANNOTATION_INVALID','CAL_DURATION_INVALID','CAL_THRESHOLD_INVALID','CAL_HIT_AMBIGUOUS','CAL_HIT_ACCOUNTING_INVALID',
  'NATIVE_LIVE_CHILD_FAILED','NATIVE_LIVE_REPORT_INVALID','NATIVE_LIVE_TIMEOUT','NATIVE_LIVE_STOP_TIMEOUT','NATIVE_LIVE_OUTPUT_LIMIT',
  'NATIVE_LIVE_PROGRESS_FAILED','NATIVE_LOCK_MISMATCH','SDK_HASH_MISMATCH','MODEL_ASSETS_UNAVAILABLE','KEYWORDS_INVALID']);
const count=(v:any)=>Number.isSafeInteger(v)&&v>=0?v:null;
const time=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=86400000?v:null;
const bool=(v:any)=>typeof v==='boolean'?v:null;
const counters=(obj:any,keys:string)=>Object.fromEntries(keys.split(' ').map(k=>[k,count(obj?.[k])]));
const times=(obj:any,keys:string)=>Object.fromEntries(keys.split(' ').map(k=>[k,time(obj?.[k])]));
const equalHash=(a:any,b:any)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(b)?a===b:null;
function equalModels(a:any,b:any){
  const keys=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'];
  if(!a||!b||Object.keys(a).length!==4||Object.keys(b).length!==4)return null;
  const matches=keys.map(k=>equalHash(a[k],b[k]));return matches.some(v=>v===null)?null:matches.every(Boolean);
}
export class ReplayObservation {
  private current:ReplayStage='DATASET_LOAD';
  private expected:{samples?:number;pcmSha256?:string;modelHashes?:any;keywordSha256?:string}={};
  private native:any=null;
  readonly cell:ReplayCell;
  constructor(cell:ReplayCell){
    if(!['POSITIVE','SILENCE','SIMILAR'].includes(cell.kind)||!/^[a-f0-9]{32}$/.test(cell.sessionId)||![.15,.1,.05].includes(cell.threshold))throw new SpikeError('CAL_ARGUMENT_INVALID');
    this.cell=Object.freeze({kind:cell.kind,sessionId:cell.sessionId,threshold:cell.threshold,timingMode:historicalTimingMode(cell.timingMode)});
  }
  stage=(value:ReplayStage)=>{if(!stages.has(value))throw new SpikeError('CAL_ARGUMENT_INVALID');this.current=value;};
  expect(value:{samples?:number;pcmSha256?:string;modelHashes?:any;keywordSha256?:string}){
    if(value.samples!==undefined)this.expected.samples=value.samples;
    for(const key of ['pcmSha256','keywordSha256'] as const)if(typeof value[key]==='string'&&/^[a-f0-9]{64}$/.test(value[key]!))this.expected[key]=value[key];
    if(value.modelHashes)this.expected.modelHashes=Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(k=>[k,typeof value.modelHashes[k]==='string'&&/^[a-f0-9]{64}$/.test(value.modelHashes[k])?value.modelHashes[k]:null]));
  }
  observeNative=(result:{report:any;exitCode:number|null})=>{
    const r=result.report,e=this.expected,c=r?.calibration;
    // Snapshot only closed codes, bounded scalar counts/timings, flags and equality.
    this.native={exitCode:Number.isInteger(result.exitCode)&&Math.abs(result.exitCode!)<=2147483648?result.exitCode:null,
      reportAvailable:!!r&&typeof r==='object',state:['FAILED','CANCELLED','COMPLETED'].includes(r?.state)?r.state:'UNKNOWN',nativeCode:nativeDiagnosticCode(r?.code),
      capture:{...counters(r?.capture,'requestedSeconds processedSamples processedBlocks resampledSamples framesReceived framesConverted unprocessedSamples unconvertedFrames overflows discontinuities sequenceErrors'),...times(r?.capture,'wallMs')},
      buffer:{...counters(r?.buffer,'queuedCapacity highWater pendingAfterCleanup abandonedBlocksOnFailure'),...times(r?.buffer,'maxQueueAgeMs maxBlockEndLatencyMs')},
      replayTiming:{timingMode:['STRICT_REALTIME','ACOUSTIC_BACKPRESSURE'].includes(r?.replayTiming?.timingMode)?r.replayTiming.timingMode:null,...counters(r?.replayTiming,'waitCount'),...times(r?.replayTiming,'capacityWaitWallMs maxCapacityWaitWallMs totalWallMs'),cancelled:bool(r?.replayTiming?.cancelled)},
      inference:{...counters(r?.inference,'decodeCalls'),...times(r?.inference,'processingWallMs maxBlockWallMs')},
      recognition:counters(r?.recognition,'rawHits detections suppressedHits'),
      details:{blocks:Array.isArray(r?.details?.blocks)?count(r.details.blocks.length):null,decodes:Array.isArray(r?.details?.decodes)?count(r.details.decodes.length):null,
        positions:Array.isArray(r?.positions)?count(r.positions.length):null},
      checks:{exitStateConsistent:(result.exitCode===0&&r?.state==='COMPLETED')||(result.exitCode===2&&r?.state==='FAILED')||(result.exitCode===130&&r?.state==='CANCELLED'),calibrationSchema1:c?c.schema===1:null,replayMode:c?c.mode==='REPLAY':null,notPersisted:c?c.persisted===false:null,
        declaredSamplesMatch:typeof c?.samples==='number'&&e.samples!==undefined?c.samples===e.samples:null,
        processedSamplesMatch:typeof r?.capture?.processedSamples==='number'&&e.samples!==undefined?r.capture.processedSamples===e.samples:null,
        processedBlocksMatch:typeof r?.capture?.processedBlocks==='number'&&e.samples!==undefined?r.capture.processedBlocks===Math.ceil(e.samples/1600):null,
        declaredPcmHashMatches:equalHash(c?.sha256,e.pcmSha256),inputPcmHashMatches:equalHash(r?.pcmSha256,e.pcmSha256),
        processedPcmHashMatches:equalHash(r?.processedPcmSha256,e.pcmSha256),modelHashesMatch:equalModels(r?.modelHashes,e.modelHashes),keywordHashMatches:equalHash(r?.keywordSha256,e.keywordSha256)},
      cleanup:Object.fromEntries(['microphoneReleased','comReleased','engineReleased','threadsJoined'].map(k=>[k,bool(r?.cleanup?.[k])]))};
    this.current='NATIVE_EXIT';
  };
  failure(error:unknown){
    const code=(error as {code?:unknown})?.code;
    const supervisorCode=typeof code==='string'&&knownErrors.has(code)?code:null;
    const nativeFailed=this.native&&(this.native.exitCode!==0||this.native.state==='FAILED'||this.native.state==='CANCELLED');
    return {schema:1,state:'REPLAY_CELL_FAILED',...this.cell,stage:this.current,
      exitCode:this.native?.exitCode??null,nativeCode:this.native?.nativeCode??null,
      code:nativeFailed?'CAL_REPLAY_NATIVE_FAILED':supervisorCode?.startsWith('CAL_')?supervisorCode:'CAL_REPLAY_EXECUTION_FAILED',
      supervisorCode,native:this.native,expectedSamples:count(this.expected.samples),productionGo:false};
  }
}
export type ReplayFailureDiagnostic=ReturnType<ReplayObservation['failure']>;
export class ReplayCellError extends SpikeError {
  constructor(readonly diagnostic:ReplayFailureDiagnostic,readonly failureReportSaved:boolean){super(diagnostic.code);}
}
export async function observeReplayCell<T>(cell:ReplayCell,operation:(observer:ReplayObservation)=>Promise<T>,save:(diagnostic:ReplayFailureDiagnostic)=>Promise<void>){
  const observer=new ReplayObservation(cell);
  try{return await operation(observer);}catch(error){
    const diagnostic=observer.failure(error);let saved=false;
    try{await save(diagnostic);saved=true;}catch{/* Never overwrite files, retry, expose filesystem text or replace the original diagnostic. */}
    throw new ReplayCellError(diagnostic,saved);
  }
}
