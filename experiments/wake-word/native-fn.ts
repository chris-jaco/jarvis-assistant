// Per-attempt diagnostics. Statistical summaries only; no audio I/O or inference.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPath,sdkHashes,sha } from './benchmark-contract.js';
import { cleanLiveReport } from './native-live.js';
import { liveKeyword } from './native-live-config.js';
import { fnPolicy,validateFnDiagnostics } from './native-fn-diagnostics.js';
import { SpikeError } from './core.js';

function fail():never{throw new SpikeError('FN_REPORT_INVALID');}
const median=(values:number[])=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),n=s.length;return n%2?s[(n-1)/2]!:(s[n/2-1]!+s[n/2]!)/2;};
function aggregate(blocks:any[]){
  const samples=blocks.reduce((s,b)=>s+b.samples,0),sumSquares=blocks.reduce((s,b)=>s+b.sumSquares,0),nearZero=blocks.reduce((s,b)=>s+b.nearZero,0);
  return {blocks:blocks.length,samples,sumSquares,rms:samples?Math.sqrt(sumSquares/samples):null,peak:blocks.length?Math.max(...blocks.map(b=>b.peak)):null,
    nearZero,nearZeroPercent:samples?100*nearZero/samples:null,clipped:blocks.reduce((s,b)=>s+b.clipped,0),invalid:blocks.reduce((s,b)=>s+b.invalid,0)};
}
function coverage(blocks:any[],start:number,end:number){
  let covered=start;
  for(const b of blocks){if(!b.completed||b.qpcEndMs<start)continue;if(b.qpcStartMs>end)break;
    if(b.qpcStartMs>covered+fnPolicy.clockGapMs)return false;covered=Math.max(covered,b.qpcEndMs);}
  return covered>=end-fnPolicy.clockGapMs;
}
export function falseNegativeReport(input:any):any{
  if(!input?.fnDiagnostics)return {schema:1,state:'NOT_EVALUABLE',reason:'DIAGNOSTICS_UNAVAILABLE',sensitivityEstimate:null};
  if(input.backend!=='NATIVE_LIVE'||input.source!=='MICROPHONE'||input.mode!=='COLD'||input.capture?.requestedSeconds!==60
    ||input.configuration?.threshold!==.15||!input.modelHashes||Object.keys(input.modelHashes).length!==4
    ||['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].some(k=>!/^[a-f0-9]{64}$/.test(input.modelHashes[k]??'')))fail();
  const expected={modelHashes:input.modelHashes,keywordSha256:sha(liveKeyword(.15))};
  if(input.runtime?.version!=='2.0.0'||JSON.stringify(Object.entries(input.runtime.dllHashes??{}).sort())!==JSON.stringify(Object.entries(sdkHashes).sort()))fail();
  let r:any;
  try{r=cleanLiveReport({...input,runtime:{version:'2.0.0',dlls:['sherpa-onnx-c-api.dll','onnxruntime.dll'].map(name=>({name,sha256:sdkHashes[name]}))}},expected,'COLD','MICROPHONE',60,.15);}catch{fail();}
  const d=validateFnDiagnostics(r.fnDiagnostics,r,r.fnDiagnostics.trialId,r.fnDiagnostics.hostMarkers),blocks=d.blocks;
  const attempts:any[]=Array.from({length:20},(_,i)=>{
    const b=d.markers[i*2],e=d.markers[i*2+1],hb=d.hostMarkers[i*2],he=d.hostMarkers[i*2+1];
    const usable=b&&e&&hb?.acknowledged&&he?.acknowledged&&hb.roundTripMs<=fnPolicy.markerRttMs&&he.roundTripMs<=fnPolicy.markerRttMs
      &&e.qpcMs>b.qpcMs&&d.channelHealthy;
    return {id:i+1,startMs:b?.qpcMs??null,endMs:e?.qpcMs??null,startUncertaintyMs:hb?.roundTripMs??null,endUncertaintyMs:he?.roundTripMs??null,
      category:'AMBIGUOUS',reason:usable?'PENDING_CLASSIFICATION':'ALIGNMENT_UNCERTAIN',usable:Boolean(usable),acceptedHits:0,rawHits:0,suppressedHits:0,duplicates:0};
  });
  // Expanded windows are not enlarged to conceal transport uncertainty.
  // Definite matches must hold for every event time inside the measured bracket.
  const initiallyUsable=attempts.map(a=>a.usable);
  for(let i=0;i<20;i++)for(let j=i+1;j<20;j++){
    const a=attempts[i],b=attempts[j];if(!initiallyUsable[i]||!initiallyUsable[j])continue;
    if(a.endMs+fnPolicy.afterMs>=b.startMs-b.startUncertaintyMs-fnPolicy.beforeMs){a.reason=b.reason='OVERLAPPING_WINDOWS';a.usable=b.usable=false;}
  }
  let lastAccepted=-Infinity,accepted=0,suppressed=0,previousBlock=-1;const events:any[]=[];
  if(r.positions.length!==r.recognition.rawHits)fail();
  for(let index=0;index<r.positions.length;index++){
    const p=r.positions[index],block=blocks[p.block];
    if(!Number.isInteger(p.block)||p.block<previousBlock||!block)fail();previousBlock=p.block;
    const isAccepted=p.block*100-lastAccepted>=1000;
    if(isAccepted){lastAccepted=p.block*100;accepted++;}else suppressed++;
    const qpcMs=block.qpcEndMs;
    const possible=attempts.filter(a=>a.startMs!==null&&a.endMs!==null&&qpcMs>=a.startMs-a.startUncertaintyMs-fnPolicy.beforeMs-fnPolicy.clockGapMs
      &&qpcMs<=a.endMs+fnPolicy.afterMs+fnPolicy.clockGapMs);
    const a=possible.length===1?possible[0]:undefined;
    const definite=a?.usable&&p.blockCompleted&&block.completed&&qpcMs>=a.startMs-fnPolicy.beforeMs+fnPolicy.clockGapMs
      &&qpcMs<=a.endMs-a.endUncertaintyMs+fnPolicy.afterMs-fnPolicy.clockGapMs;
    if(definite){a.rawHits++;if(isAccepted)a.acceptedHits++;else a.suppressedHits++;}
    else for(const item of possible){item.usable=false;item.reason='HIT_ALIGNMENT_UNCERTAIN';}
    events.push({index,block:p.block,qpcMs,accepted:isAccepted,attemptId:definite?a.id:null,ambiguous:!definite&&possible.length>0,
      latencyFromAnnotatedEndMs:definite?qpcMs+p.latencyFromBlockEndMs-a.endMs:null,acousticLatencyMs:null});
  }
  if(accepted!==r.recognition.detections||suppressed!==r.recognition.suppressedHits)fail();
  for(const a of attempts){
    if(!a.usable)continue;
    const contextStart=a.startMs-a.startUncertaintyMs-fnPolicy.beforeMs,contextEnd=a.endMs+fnPolicy.afterMs;
    const outer=blocks.filter((b:any)=>b.qpcEndMs>a.startMs-a.startUncertaintyMs&&b.qpcStartMs<a.endMs);
    const inner=blocks.filter((b:any)=>b.qpcStartMs>=a.startMs&&b.qpcEndMs<=a.endMs-a.endUncertaintyMs);
    a.signal={domain:'POST_FIR_MONO_16000',wholeInnerBlocks:aggregate(inner),overlappingOuterBlocks:aggregate(outer),partialBlockMetricsReconstructed:false};
    a.decodeCallsDuringWindow=d.decodes.filter((v:any)=>v.startMs>=a.startMs&&v.startMs<=a.endMs).length;
    a.decodeCallsInPostMargin=d.decodes.filter((v:any)=>v.startMs>a.endMs&&v.startMs<=contextEnd).length;
    const next=d.decodes.find((v:any)=>v.startMs>=a.endMs);a.wallMsToFirstDecodeAfterEnd=next?next.startMs-a.endMs:null;
    const relevant=blocks.filter((b:any)=>b.qpcEndMs>contextStart&&b.qpcStartMs<contextEnd);
    if(!coverage(blocks,contextStart,contextEnd)||relevant.some((b:any)=>!b.completed||b.invalid)){
      a.category=a.acceptedHits?'AMBIGUOUS':'MISSED_CAPTURE_ISSUE';a.reason='INCOMPLETE_OR_INVALID_PCM_COVERAGE';continue;
    }
    if(relevant.some((b:any,i:number)=>i>0&&Math.abs(b.qpcStartMs-relevant[i-1].qpcEndMs)>fnPolicy.clockGapMs)){
      a.category='AMBIGUOUS';a.reason='QPC_TIMELINE_DISCONTINUITY';continue;
    }
    if(a.acceptedHits){a.category='MATCHED';a.reason='UNIQUE_WINDOW_ASSOCIATION';a.duplicates=Math.max(0,a.acceptedHits-1);continue;}
    const x=a.signal.wholeInnerBlocks,y=a.signal.overlappingOuterBlocks;
    if(!inner.length||x.clipped||y.clipped){a.reason=inner.length?'CLIPPING_INDICATOR':'SUB_BLOCK_WINDOW';continue;}
    const low=(m:any)=>m.rms<fnPolicy.lowRms&&m.peak<fnPolicy.lowPeak;
    if(low(x)!==low(y)){a.reason='BOUNDARY_SIGNAL_UNCERTAIN';continue;}
    a.category=low(x)?'MISSED_LOW_SIGNAL':'MISSED_WITH_VALID_AUDIO';
    a.reason=a.suppressedHits?'COOLDOWN_SUPPRESSED':'NO_ACCEPTED_HIT_CAUSE_UNKNOWN';
  }
  const counts=Object.fromEntries(['MATCHED','MISSED_WITH_VALID_AUDIO','MISSED_LOW_SIGNAL','MISSED_CAPTURE_ISSUE','AMBIGUOUS'].map(k=>[k,attempts.filter(a=>a.category===k).length]));
  const evaluable=attempts.filter(a=>a.category==='MATCHED'||a.category==='MISSED_WITH_VALID_AUDIO'||a.category==='MISSED_LOW_SIGNAL');
  const fullyAligned=attempts.every(a=>a.usable),complete=r.state==='COMPLETED'&&evaluable.length===20;
  const energy=(category:string)=>{const values=attempts.filter(a=>a.category===category&&a.signal).map(a=>a.signal.wholeInnerBlocks.rms).filter((v:any)=>typeof v==='number');return {attempts:values.length,medianRms:median(values)};};
  return {schema:1,state:'DIAGNOSED',trialId:d.trialId,trialComplete:r.state==='COMPLETED',modelHashes:r.modelHashes,configuration:r.configuration,format:r.format,
    policy:fnPolicy,annotatedAttempts:d.markers.filter((m:any)=>m.kind==='E').length,evaluableAttempts:evaluable.length,counts,
    sensitivityEstimate:complete?counts.MATCHED!/20:null,duplicates:attempts.reduce((s,a)=>s+a.duplicates,0),
    falsePositives:fullyAligned?events.filter(e=>e.accepted&&e.attemptId===null&&!e.ambiguous).length:null,events,attempts,
    energyByCategory:{matched:energy('MATCHED'),missedWithValidAudio:energy('MISSED_WITH_VALID_AUDIO'),missedLowSignal:energy('MISSED_LOW_SIGNAL')},
    rawSignalContext:{domain:'PRE_FIR_SESSION_ONLY',channels:r.channels},observerOverhead:{wallMs:blocks.reduce((s:number,b:any)=>s+b.metricsWallMs,0),maxBlockMs:blocks.length?Math.max(...blocks.map((b:any)=>b.metricsWallMs)):null},performance:r.inference,stability:r.capture,memory:r.memory,cleanup:r.cleanup,
    interpretation:'VALID_PCM_DOES_NOT_PROVE_INTELLIGIBLE_SPEECH_OR_MODEL_CAUSALITY',acceptance:'WINDOWS_MANUAL_ACCEPTANCE_PENDING'};
}

const stable=(value:any):string=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
function comparisonSummary(r:any){
  const categories=['MATCHED','MISSED_WITH_VALID_AUDIO','MISSED_LOW_SIGNAL','MISSED_CAPTURE_ISSUE','AMBIGUOUS'];
  if(r?.schema!==1||r.state!=='DIAGNOSED'||!/^[a-f0-9]{32}$/.test(r.trialId??'')||stable(r.policy)!==stable(fnPolicy)
    ||!Array.isArray(r.attempts)||r.attempts.length!==20)fail();
  const counts=Object.fromEntries(categories.map(category=>{
    const n=r.counts?.[category];if(!Number.isInteger(n)||n<0||n>20||r.attempts.filter((a:any)=>a?.category===category).length!==n)fail();
    return [category,n];
  }));
  if(Object.values(counts).reduce((a,b)=>a+b,0)!==20||r.evaluableAttempts!==counts.MATCHED+counts.MISSED_WITH_VALID_AUDIO+counts.MISSED_LOW_SIGNAL
    ||(r.sensitivityEstimate!==null&&(!r.trialComplete||r.evaluableAttempts!==20||r.sensitivityEstimate!==counts.MATCHED/20)))fail();
  const energy=Object.fromEntries(['matched','missedWithValidAudio','missedLowSignal'].map(key=>{
    const v=r.energyByCategory?.[key];if(!v||!Number.isInteger(v.attempts)||v.attempts<0||v.attempts>20
      ||(v.medianRms!==null&&(typeof v.medianRms!=='number'||!Number.isFinite(v.medianRms)||v.medianRms<0)))fail();
    return [key,{attempts:v.attempts,medianRms:v.medianRms}];
  }));
  return {counts,evaluable:r.evaluableAttempts,energy};
}
export function compareFnSessions(a:any,b:any){
  const x=comparisonSummary(a),y=comparisonSummary(b);
  if(a.state!=='DIAGNOSED'||b.state!=='DIAGNOSED'||stable(a.modelHashes)!==stable(b.modelHashes)
    ||stable(a.configuration)!==stable(b.configuration)||stable(a.format)!==stable(b.format)||a.trialId===b.trialId)fail();
  return {state:'COMPARED',sessionA:{counts:x.counts,evaluable:x.evaluable},sessionB:{counts:y.counts,evaluable:y.evaluable},
    matchedDifference:y.counts.MATCHED-x.counts.MATCHED,energyA:x.energy,energyB:y.energy,
    interpretation:'CORRELATION_ONLY_NOT_PROOF_OF_ARTICULATION_OR_MODEL_CAUSE',sensitivityInterpretable:a.sensitivityEstimate!==null&&b.sensitivityEstimate!==null};
}
async function load(path:string){const bytes=await readFile(await localPath(path));if(bytes.length>4*1024*1024)fail();return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [operation,a,b]=process.argv.slice(2);if(!a)fail();
    if(operation==='analyze'&&process.argv.length===4)console.log(JSON.stringify(falseNegativeReport(await load(a))));
    else if(operation==='compare'&&b&&process.argv.length===5)console.log(JSON.stringify(compareFnSessions(await load(a),await load(b))));else fail();
  }catch(error){console.log(JSON.stringify({state:'FAILED',code:error instanceof SpikeError?error.code:'FN_REPORT_INVALID'}));process.exitCode=2;}
}
