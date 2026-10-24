// Post-session numeric annotations only. No microphone, sockets, PCM or transcription.
import { readFile,access } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { sha, localPath, sdkHashes } from './benchmark-contract.js';
import { cleanLiveReport } from './native-live.js';
import { liveKeyword, checkedThreshold } from './native-live-config.js';
import { SpikeError } from './core.js';

export const matchingMargin = {beforeMs:250,afterMs:1000} as const;
type Kind='VOICE'|'SILENCE'|'SIMILAR';
type Window={id:number;startMs:number;endMs:number};
export interface Annotations {schema:1;kind:Kind;clock:'AUDIO_SAMPLE_MS';reviewed:boolean;alignmentConfirmed:boolean;reportSha256:string;attempts:number;windows:Window[]}
function fail(code:string):never{throw new SpikeError(code);}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function keys(value:any,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('ANNOTATION_INVALID');}
export function annotationTemplate(reportSha256:string,kind:Kind):Annotations{
  if(!/^[a-f0-9]{64}$/.test(reportSha256)||!['VOICE','SILENCE','SIMILAR'].includes(kind))fail('ANNOTATION_INVALID');
  return {schema:1,kind,clock:'AUDIO_SAMPLE_MS',reviewed:false,alignmentConfirmed:false,reportSha256,attempts:kind==='SILENCE'?0:20,windows:[]};
}
// A separate terminal observes the trial. It never communicates with the capture
// process. Its stopwatch alignment is manual, not a synchronized hardware clock.
export class ManualWindows {
  private start:number|undefined;
  private open:number|undefined;
  private done=false;
  private windows:Window[]=[];
  constructor(private kind:Kind,private now=()=>performance.now()){
    if(!['VOICE','SIMILAR','SILENCE'].includes(kind))fail('ANNOTATION_INVALID');
  }
  status(){return {closedWindows:this.windows.length,openWindow:this.open!==undefined,
    elapsedMs:this.start===undefined?null:this.now()-this.start};}
  command(command:string):{complete:boolean;windows?:Window[]}{
    if(this.done)fail('ANNOTATION_INVALID');
    if(command==='start'&&this.start===undefined){this.start=this.now();return {complete:false};}
    if(this.start===undefined)fail('ANNOTATION_INVALID');
    const ms=this.now()-this.start;
    if(!finite(ms))fail('ANNOTATION_INVALID');
    if(command==='b'&&this.kind!=='SILENCE'&&this.open===undefined&&this.windows.length<100){this.open=ms;return {complete:false};}
    if(command==='e'&&this.open!==undefined&&ms>this.open){this.windows.push({id:this.windows.length+1,startMs:this.open,endMs:ms});this.open=undefined;return {complete:false};}
    if(command==='confirm'&&this.open===undefined){this.done=true;return {complete:true,windows:structuredClone(this.windows)};}
    fail('ANNOTATION_INVALID');
  }
}
async function annotate(reportPath:string,kind:Kind){
  // Require a new report filename; run this terminal before launching Native Live.
  await localPath(dirname(resolve(reportPath)));
  let exists=false;try{await access(reportPath);exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(exists)fail('ANNOTATION_REPORT_EXISTS');
  const recorder=new ManualWindows(kind),lines=createInterface({input:process.stdin});
  console.error('En otro terminal ejecutar el ensayo. Al ver CAPTURE_STARTED: start; b/e antes/después de cada pronunciación.');
  console.error('Tras finalizar el ensayo, revisar sincronización y conteo; confirm confirma esa revisión. No escribir palabras ni datos privados.');
  try{
    for await(const line of lines){
      const result=recorder.command(line);
      if(result.complete){
        const bytes=await readFile(await localPath(reportPath));
        const report=parseJson(bytes);
        if(report?.schema!==1||report.backend!=='NATIVE_LIVE'||report.source!=='MICROPHONE'||report.mode!=='COLD'||report.state!=='COMPLETED')fail('SENSITIVITY_PROTOCOL_MISMATCH');
        const windows=result.windows!;
        return {...annotationTemplate(sha(bytes),kind),reviewed:true,alignmentConfirmed:true,attempts:windows.length,windows};
      }
      console.error(JSON.stringify({stage:'ANNOTATION_EVENT_ACCEPTED',...recorder.status()}));
    }
    fail('ANNOTATION_UNREVIEWED');
  }finally{lines.close();}
}
export function validateAnnotations(value:any,hash:string,durationMs:number):asserts value is Annotations{
  keys(value,['schema','kind','clock','reviewed','alignmentConfirmed','reportSha256','attempts','windows']);
  if(value.schema!==1||!['VOICE','SILENCE','SIMILAR'].includes(value.kind)||value.clock!=='AUDIO_SAMPLE_MS'||value.reportSha256!==hash
    ||!Number.isInteger(value.attempts)||value.attempts<0||value.attempts>100||!Array.isArray(value.windows)||value.windows.length!==value.attempts)fail('ANNOTATION_INVALID');
  if(value.reviewed!==true||value.alignmentConfirmed!==true)fail('ANNOTATION_UNREVIEWED');
  if((value.kind==='SILENCE'&&value.attempts!==0)||(value.kind!=='SILENCE'&&value.attempts<1))fail('ANNOTATION_INVALID');
  let previousEnd=-1;
  for(let i=0;i<value.windows.length;i++){
    const w=value.windows[i];keys(w,['id','startMs','endMs']);
    if(w.id!==i+1||!finite(w.startMs)||!finite(w.endMs)||w.endMs<=w.startMs||w.endMs>durationMs||w.startMs<previousEnd)fail('ANNOTATION_INVALID');
    previousEnd=w.endMs;
  }
}
export function sensitivityTrial(report:any,annotations:any,reportHash:string){
  if(!/^[a-f0-9]{64}$/.test(reportHash))fail('ANNOTATION_INVALID');
  if(report?.state!=='COMPLETED')return {schema:1,state:'EXCLUDED',reason:'TRIAL_NOT_COMPLETED',reportSha256:reportHash};
  const threshold=checkedThreshold(report.configuration?.threshold);
  if(report.source!=='MICROPHONE'||report.mode!=='COLD'||report.capture?.requestedSeconds!==60)fail('SENSITIVITY_PROTOCOL_MISMATCH');
  // Accept the supervisor's allowlisted JSON, but reapply its integrity checks.
  if(report.runtime?.version!=='2.0.0'||JSON.stringify(Object.entries(report.runtime.dllHashes??{}).sort())!==JSON.stringify(Object.entries(sdkHashes).sort()))fail('REPORT_IDENTITY_INVALID');
  const modelNames=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'];
  if(!report.modelHashes||Object.keys(report.modelHashes).length!==4||modelNames.some(k=>!/^[a-f0-9]{64}$/.test(report.modelHashes[k]??'')))fail('REPORT_IDENTITY_INVALID');
  const expected={modelHashes:report.modelHashes,keywordSha256:sha(liveKeyword(threshold))};
  let clean:any;
  try{clean=cleanLiveReport({...report,thresholdEvidence:report.thresholdEvidence??undefined,
    runtime:{version:'2.0.0',dlls:['sherpa-onnx-c-api.dll','onnxruntime.dll'].map(name=>({name,sha256:sdkHashes[name]}))}},expected,'COLD','MICROPHONE',60,threshold);}
  catch{fail('SENSITIVITY_REPORT_INVALID');}
  const durationMs=clean.capture.processedSamples/16;
  validateAnnotations(annotations,reportHash,durationMs);
  const matched=annotations.windows.map((w:Window)=>({id:w.id,rawHits:0,acceptedHits:0,suppressedHits:0}));
  const events:any[]=[];
  let lastAcceptedMs=-Infinity,accepted=0,suppressed=0,previousBlock=-1,ambiguous=0,unmatchedRaw=0,unmatchedAccepted=0;
  if(clean.positions.length!==clean.recognition.rawHits)fail('HIT_ACCOUNTING_INVALID');
  for(let i=0;i<clean.positions.length;i++){
    const p=clean.positions[i];
    if(!p.blockCompleted||!Number.isInteger(p.block)||p.block<previousBlock||p.block<0||p.block>=clean.capture.processedBlocks
      ||p.audioSampleEnd!==Math.min(clean.capture.processedSamples,(p.block+1)*1600))fail('HIT_ACCOUNTING_INVALID');
    previousBlock=p.block;
    // Same sample clock as Native Feed: block start controls the 1000 ms cooldown.
    const hitMs=p.audioSampleEnd/16,acceptedHit=p.block*100-lastAcceptedMs>=1000;
    if(acceptedHit){accepted++;lastAcceptedMs=p.block*100;}else suppressed++;
    const candidates=annotations.windows.filter((w:Window)=>hitMs>=w.startMs-matchingMargin.beforeMs&&hitMs<=w.endMs+matchingMargin.afterMs);
    let windowId:number|null=null;
    if(candidates.length>1)ambiguous++;
    else if(candidates.length===1){windowId=candidates[0]!.id;const m=matched[windowId!-1]!;m.rawHits++;if(acceptedHit)m.acceptedHits++;else m.suppressedHits++;}
    else{unmatchedRaw++;if(acceptedHit)unmatchedAccepted++;}
    events.push({rawHitIndex:i,block:p.block,audioSampleEnd:p.audioSampleEnd,hitMs,accepted:acceptedHit,windowId,ambiguous:candidates.length>1,
      latencyFromBlockEndMs:p.latencyFromBlockEndMs});
  }
  if(accepted!==clean.recognition.detections||suppressed!==clean.recognition.suppressedHits)fail('HIT_ACCOUNTING_INVALID');
  const target=annotations.kind==='VOICE';
  const associated=target?matched.filter((m:any)=>m.acceptedHits>0).length:0;
  const duplicates=target?matched.reduce((sum:number,m:any)=>sum+Math.max(0,m.acceptedHits-1),0):0;
  const rawDuplicates=target?matched.reduce((sum:number,m:any)=>sum+Math.max(0,m.rawHits-1),0):0;
  const sensitivity=target&&!ambiguous?associated/annotations.attempts:null;
  const rawFalsePositives=target?unmatchedRaw:clean.recognition.rawHits;
  const falsePositives=target?unmatchedAccepted:accepted;
  const protocolComplete=annotations.kind==='SILENCE'?annotations.attempts===0:annotations.attempts===20;
  const performance={firstDecodeWallMs:clean.inference.firstDecodeWallMs,p95DecodeWallMs:clean.inference.p95DecodeWallMs,
    maxDecodeWallMs:clean.inference.maxDecodeWallMs,maxBlockWallMs:clean.inference.maxBlockWallMs,rtf:clean.inference.rtf,
    overflows:clean.capture.overflows,discontinuities:clean.capture.discontinuities,initialDiscontinuities:clean.capture.initialDiscontinuities,
    sequenceErrors:clean.capture.sequenceErrors,unprocessedSamples:clean.capture.unprocessedSamples,highWater:clean.buffer.highWater,
    maxQueueAgeMs:clean.buffer.maxQueueAgeMs,memory:clean.memory,cleanup:clean.cleanup};
  return {schema:1,state:ambiguous?'NEEDS_REVIEW':'CLASSIFIED',reportSha256:reportHash,threshold,kind:annotations.kind,
    modelHashes:clean.modelHashes,keywordSha256:clean.keywordSha256,configuration:clean.configuration,format:clean.format,
    clock:'AUDIO_SAMPLE_MS',margin:matchingMargin,windowAnnotation:'MANUAL_ESTIMATE_NOT_ACOUSTIC_GROUND_TRUTH',protocolComplete,
    rawHits:clean.recognition.rawHits,detections:accepted,suppressedHits:suppressed,associatedPronunciations:target?associated:null,
    omittedPronunciations:target&&!ambiguous?annotations.attempts-associated:null,duplicateDetections:duplicates,rawDuplicateHits:rawDuplicates,
    rawFalsePositives,falsePositives,ambiguousHits:ambiguous,sensitivityEstimate:sensitivity,windows:matched,events,performance,
    meetsTrialCriteria:protocolComplete&&!ambiguous&&clean.technicalThresholdsMet
      &&(target?sensitivity!==null&&sensitivity>=.9&&duplicates===0&&rawFalsePositives===0:rawFalsePositives===0),
    acceptance:'EXPERIMENTAL_ONLY_NO_AUTOMATIC_APPROVAL'};
}

const parseJson=(bytes:Buffer)=>{if(bytes.length>4*1024*1024)fail('REPORT_TOO_LARGE');try{return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('REPORT_JSON_INVALID');}};
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [operation,reportPath,last]=process.argv.slice(2);
    if(process.argv.length!==5||!reportPath)fail('ARGUMENT_INVALID');
    if(operation==='annotate')console.log(JSON.stringify(await annotate(reportPath,last as Kind)));
    else {
    const bytes=await readFile(await localPath(reportPath)),hash=sha(bytes),report=parseJson(bytes);
    if(operation==='template')console.log(JSON.stringify(annotationTemplate(hash,last as Kind)));
    else if(operation==='analyze'&&last){
      const annotations=parseJson(await readFile(await localPath(last)));
      const result=sensitivityTrial(report,annotations,hash);console.log(JSON.stringify(result));if(result.state!=='CLASSIFIED')process.exitCode=2;
    }else fail('ARGUMENT_INVALID');
    }
  }catch(error){const allowed=['THRESHOLD_INVALID','ARGUMENT_INVALID','ANNOTATION_INVALID','ANNOTATION_UNREVIEWED','ANNOTATION_REPORT_EXISTS','REPORT_IDENTITY_INVALID','REPORT_JSON_INVALID','REPORT_TOO_LARGE','SENSITIVITY_PROTOCOL_MISMATCH','SENSITIVITY_REPORT_INVALID','HIT_ACCOUNTING_INVALID'];
    console.log(JSON.stringify({state:'FAILED',code:error instanceof SpikeError&&allowed.includes(error.code)?error.code:'SENSITIVITY_INPUT_FAILED'}));process.exitCode=2;}
}
