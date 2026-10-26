// Metadata-only diagnostics. No audio, filesystem, timers or native calls.
import { SpikeError } from './core.js';
import { fnPolicy,validateFnDiagnostics } from './native-fn-diagnostics.js';
export type AlignmentReason='PRE_CONTEXT_MISSING'|'POST_CONTEXT_MISSING'|'QPC_DISCONTINUITY'|'MARKER_OUTSIDE_COVERAGE'|'MARKER_UNCERTAINTY_OVERLAP'|'EXPANDED_WINDOWS_OVERLAP'|'INSUFFICIENT_EVIDENCE';
export interface AlignmentIssue {
  reason:AlignmentReason;windowId?:number;previousWindowId?:number;markerId?:number;block?:number;
  qpcMs?:number;beginQpcMs?:number;endQpcMs?:number;previousMarkerQpcMs?:number;roundTripMs?:number;qpcLowerMs?:number;qpcUpperMs?:number;previousQpcEndMs?:number;blockQpcStartMs?:number;blockQpcEndMs?:number;
  observedSeparationMs?:number;minimumRequiredMs?:number;maximumAllowedMs?:number;deficitMs?:number;
}
export class CalibrationAlignmentError extends SpikeError {
  constructor(readonly diagnostics:AlignmentIssue[]){super('CAL_ALIGNMENT_AMBIGUOUS');}
}
// The comparisons, rounding and sentinel are the published acceptance contract.
// Collect every independently evaluable failure; never invent a mapping after a failed point.
export function inspectCalibrationAlignment(report:any,kind:string,d:any){
  const diagnostics:AlignmentIssue[]=[],windows:any[]=[];
  const add=(reason:AlignmentReason,fields:Omit<AlignmentIssue,'reason'>={})=>diagnostics.push({reason,...fields});
  if(!d||!d.channelHealthy||d.blocks.length===0){add('INSUFFICIENT_EVIDENCE');return {windows,diagnostics};}
  if(kind==='SILENCE'){
    if(d.markers.length||d.hostMarkers.length)add('INSUFFICIENT_EVIDENCE');return {windows,diagnostics};
  }
  if(d.markers.length!==40||d.hostMarkers.length!==40){add('INSUFFICIENT_EVIDENCE');return {windows,diagnostics};}
  function point(i:number){
    const marker=d.markers[i],host=d.hostMarkers[i],windowId=Math.floor(i/2)+1,markerId=marker.id;
    if(!host.acknowledged||host.roundTripMs>fnPolicy.markerRttMs){add('INSUFFICIENT_EVIDENCE',{windowId,markerId,qpcMs:marker.qpcMs,...(host.roundTripMs!==null?{roundTripMs:host.roundTripMs,maximumAllowedMs:fnPolicy.markerRttMs}:{})});return;}
    const low=marker.qpcMs-host.roundTripMs-fnPolicy.clockGapMs,high=marker.qpcMs+fnPolicy.clockGapMs;
    const context={windowId,markerId,qpcMs:marker.qpcMs,qpcLowerMs:low,qpcUpperMs:high};
    const blocks=d.blocks.filter((b:any)=>b.qpcEndMs>=low&&b.qpcStartMs<=high);
    if(!blocks.length||blocks[0].qpcStartMs>low||blocks.at(-1).qpcEndMs<high){
      add('MARKER_OUTSIDE_COVERAGE',{...context,...(blocks.length?{block:blocks[0].sequence,blockQpcStartMs:blocks[0].qpcStartMs,blockQpcEndMs:blocks.at(-1).qpcEndMs,
        deficitMs:Math.max(0,blocks[0].qpcStartMs-low,high-blocks.at(-1).qpcEndMs)}:{})});return;
    }
    let end=blocks[0].qpcStartMs,valid=true;const limits:number[]=[];
    for(const b of blocks){
      if(!b.completed||b.invalid){add('INSUFFICIENT_EVIDENCE',{...context,block:b.sequence});valid=false;}
      if(Math.abs(b.qpcStartMs-end)>fnPolicy.clockGapMs){
        add('QPC_DISCONTINUITY',{...context,block:b.sequence,previousQpcEndMs:end,blockQpcStartMs:b.qpcStartMs,
          observedSeparationMs:b.qpcStartMs-end,maximumAllowedMs:fnPolicy.clockGapMs,deficitMs:Math.abs(b.qpcStartMs-end)-fnPolicy.clockGapMs});valid=false;
      }
      limits.push(b.sampleStart+(Math.max(low,b.qpcStartMs)-b.qpcStartMs)*16,b.sampleStart+(Math.min(high,b.qpcEndMs)-b.qpcStartMs)*16);end=b.qpcEndMs;
    }
    if(!valid)return;
    const lower=Math.floor(Math.min(...limits)),upper=Math.ceil(Math.max(...limits));
    return {lower,upper,qpcMs:marker.qpcMs,roundTripMs:host.roundTripMs,uncertaintySamples:upper-lower,
      offsetLowerMs:marker.qpcMs-upper/16,offsetUpperMs:marker.qpcMs-lower/16};
  }
  for(let i=0;i<20;i++)windows.push({id:i+1,begin:point(i*2),end:point(i*2+1)});
  let previous:number|undefined=-1,previousWindowId:number|undefined,previousMarkerQpcMs:number|undefined;
  for(const w of windows){
    if(w.begin&&w.end){
      if(w.begin.upper>=w.end.lower)add('MARKER_UNCERTAINTY_OVERLAP',{windowId:w.id,markerId:w.id*2,
        beginQpcMs:w.begin.qpcMs,endQpcMs:w.end.qpcMs,observedSeparationMs:(w.end.lower-w.begin.upper)/16,minimumRequiredMs:1/16,deficitMs:(w.begin.upper-w.end.lower+1)/16});
      if(w.begin.lower<4000)add('PRE_CONTEXT_MISSING',{windowId:w.id,markerId:w.id*2-1,qpcMs:w.begin.qpcMs,
        observedSeparationMs:w.begin.lower/16,minimumRequiredMs:250,deficitMs:(4000-w.begin.lower)/16});
      if(w.end.upper+16000>report.capture.processedSamples)add('POST_CONTEXT_MISSING',{windowId:w.id,markerId:w.id*2,qpcMs:w.end.qpcMs,
        observedSeparationMs:(report.capture.processedSamples-w.end.upper)/16,minimumRequiredMs:1000,deficitMs:(w.end.upper+16000-report.capture.processedSamples)/16});
      if(previous!==undefined&&w.begin.lower-4000<=previous)add('EXPANDED_WINDOWS_OVERLAP',{windowId:w.id,previousWindowId,previousMarkerQpcMs,markerId:w.id*2-1,qpcMs:w.begin.qpcMs,
        observedSeparationMs:(w.begin.lower-4000-previous)/16,minimumRequiredMs:1/16,deficitMs:(previous-(w.begin.lower-4000)+1)/16});
      const relevant=d.blocks.filter((b:any)=>b.sampleEnd>w.begin.lower-4000&&b.sampleStart<w.end.upper+16000);
      for(let i=0;i<relevant.length;i++){
        const b=relevant[i];
        if(!b.completed||b.invalid)add('INSUFFICIENT_EVIDENCE',{windowId:w.id,block:b.sequence});
        if(i&&Math.abs(b.qpcStartMs-relevant[i-1].qpcEndMs)>fnPolicy.clockGapMs)add('QPC_DISCONTINUITY',{windowId:w.id,block:b.sequence,
          previousQpcEndMs:relevant[i-1].qpcEndMs,blockQpcStartMs:b.qpcStartMs,observedSeparationMs:b.qpcStartMs-relevant[i-1].qpcEndMs,
          maximumAllowedMs:fnPolicy.clockGapMs,deficitMs:Math.abs(b.qpcStartMs-relevant[i-1].qpcEndMs)-fnPolicy.clockGapMs});
      }
    }
    // Do not bridge over an unmappable neighbouring window.
    previous=w.end?w.end.upper+16000:undefined;previousWindowId=w.id;previousMarkerQpcMs=w.end?.qpcMs;
  }
  return {windows,diagnostics};
}
// Read-only audit entry point: incomplete/legacy metadata is not accepted as evidence.
export function auditCalibrationAlignment(report:any,kind:string){
  try{
    if(!['POSITIVE','SIMILAR','SILENCE'].includes(kind)||report?.state!=='COMPLETED'||report?.source!=='MICROPHONE'||report?.mode!=='COLD'||report?.configuration?.threshold!==.15
      ||!Number.isSafeInteger(report?.capture?.processedSamples))throw new Error();
    const seconds=report.capture.requestedSeconds===undefined?60:report.capture.requestedSeconds;
    if(seconds!==60&&!((seconds===120||seconds===180)&&kind!=='SILENCE'))throw new Error();
    const d=validateFnDiagnostics(report.fnDiagnostics,report,report.fnDiagnostics?.trialId,report.fnDiagnostics?.hostMarkers);
    const result=inspectCalibrationAlignment(report,kind,d);
    return {state:result.diagnostics.length?'ALIGNMENT_REJECTED':'ALIGNMENT_VALID',diagnostics:result.diagnostics,
      affectedWindows:[...new Set(result.diagnostics.flatMap(d=>d.windowId?[d.windowId]:[]))],productionGo:false};
  }catch{return {state:'NOT_EVALUABLE',diagnostics:[{reason:'INSUFFICIENT_EVIDENCE' as const}],affectedWindows:[],productionGo:false};}
}
