import { calibrationBlockLimit } from './calibration-limits.js';
import { SpikeError } from './core.js';

export const fnPolicy={markerRttMs:50,clockGapMs:2,beforeMs:250,afterMs:1000,lowRms:.003,lowPeak:.02};
export interface HostMarker{id:number;kind:'B'|'E';acknowledged:boolean;qpcMs:number|null;roundTripMs:number|null}
function fail():never{throw new SpikeError('FN_DIAGNOSTICS_INVALID');}
const number=(v:any):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const integer=(v:any)=>Number.isSafeInteger(v)&&v>=0;
export class NativeMarkers {
  private ready=false;private closed=false;private pending=false;
  private write:((value:string)=>void)|undefined;
  private records:Array<HostMarker&{sent:number}>=[];
  constructor(readonly trialId:string,private now=()=>performance.now()){
    if(!/^[0-9a-f]{32}$/.test(trialId))fail();
  }
  attach(write:(value:string)=>void){this.write=write;}
  stage(stage:string){if(stage==='CAPTURE_STARTED')this.ready=true;if(stage==='CAPTURE_STOPPED')this.ready=false;}
  mark(kind:'B'|'E'){
    const id=this.records.length+1;
    if(!this.ready||this.closed||this.pending||!this.write||id>40||kind!==(id%2?'B':'E'))return false;
    const record={id,kind,acknowledged:false,qpcMs:null,roundTripMs:null,sent:this.now()};
    this.records.push(record);this.pending=true;
    try{this.write(`M ${this.trialId} ${id} ${kind}\n`);}catch{this.close();fail();}return true;
  }
  ack(line:string){
    const m=/^ACK ([a-f0-9]{32}) ([1-9]|[1-3][0-9]|40) ([BE]) ([0-9]+(?:\.[0-9]+)?)$/.exec(line);
    if(!m||m[1]!==this.trialId||this.closed||!this.pending)fail();
    const r=this.records[this.records.length-1]!;const qpcMs=Number(m[4]),rtt=this.now()-r.sent;
    if(r.id!==Number(m[2])||r.kind!==m[3]||!number(qpcMs)||!number(rtt))fail();
    r.qpcMs=qpcMs;r.roundTripMs=rtt;r.acknowledged=true;this.pending=false;
    return {id:r.id,kind:r.kind,roundTripMs:rtt,alignmentUsable:rtt<=fnPolicy.markerRttMs};
  }
  close(){this.closed=true;this.ready=false;}
  snapshot():HostMarker[]{return this.records.map(({sent,...r})=>({...r}));}
}

// A new optional contract. No legacy report is treated as diagnostic evidence.
export function validateFnDiagnostics(value:any,report:any,expectedTrial?:string,host:HostMarker[]=[]):any{
  if(value===undefined){if(expectedTrial)fail();return undefined;}
  if(value?.schema!==1||!/^[0-9a-f]{32}$/.test(value.trialId??'')||(expectedTrial&&value.trialId!==expectedTrial)
    ||value.clock!=='QPC_RELATIVE_MS'||value.signalDomain!=='POST_FIR_MONO_16000'||typeof value.channelHealthy!=='boolean'
    ||!Array.isArray(value.blocks)||value.blocks.length>calibrationBlockLimit(report?.capture?.requestedSeconds)||!Array.isArray(value.decodes)||value.decodes.length>10000
    ||!Array.isArray(value.markers)||value.markers.length>40)fail();
  const blocks=value.blocks.map((b:any,i:number)=>{
    for(const key of ['sequence','sampleStart','sampleEnd','samples','nearZero','clipped','invalid','decodeCalls','rawHits'])if(!integer(b[key]))fail();
    for(const key of ['qpcStartMs','qpcEndMs','sumSquares','rms','peak','metricsWallMs'])if(!number(b[key]))fail();
    if(b.sequence!==i||b.sampleStart!==i*1600||b.samples<1||b.samples>1600||b.sampleEnd-b.sampleStart!==b.samples
      ||b.qpcEndMs<=b.qpcStartMs||Math.abs((b.qpcEndMs-b.qpcStartMs)-b.samples/16)>1e-5
      ||typeof b.completed!=='boolean'||b.invalid+b.nearZero+b.clipped>b.samples
      ||Math.abs(b.rms-Math.sqrt(b.sumSquares/b.samples))>1e-7
      ||(b.clipped>0&&b.peak<.999)
      ||b.sumSquares>(b.samples-b.invalid)*b.peak*b.peak+1e-7||b.peak*b.peak>b.sumSquares+1e-7)fail();
    if(i&&b.qpcEndMs<=value.blocks[i-1].qpcEndMs)fail();
    return {sequence:b.sequence,sampleStart:b.sampleStart,sampleEnd:b.sampleEnd,samples:b.samples,qpcStartMs:b.qpcStartMs,qpcEndMs:b.qpcEndMs,
      sumSquares:b.sumSquares,rms:b.rms,peak:b.peak,nearZero:b.nearZero,nearZeroPercent:100*b.nearZero/b.samples,clipped:b.clipped,invalid:b.invalid,metricsWallMs:b.metricsWallMs,
      completed:b.completed,decodeCalls:b.decodeCalls,rawHits:b.rawHits};
  });
  const decodes=value.decodes.map((d:any,i:number)=>{
    if(!integer(d.block)||d.block>=blocks.length||!number(d.startMs)||!number(d.endMs)||d.endMs<d.startMs
      ||(i&&d.startMs<value.decodes[i-1].endMs))fail();
    return {block:d.block,startMs:d.startMs,endMs:d.endMs};
  });
  const markers=value.markers.map((m:any,i:number)=>{
    if(m.id!==i+1||m.kind!==(i%2?'E':'B')||!number(m.qpcMs)||(i&&m.qpcMs<value.markers[i-1].qpcMs))fail();
    return {id:m.id,kind:m.kind,qpcMs:m.qpcMs};
  });
  if(!Array.isArray(host)||host.length>40)fail();
  const hostMarkers=host.map((m:any,i:number)=>{
    if(m.id!==i+1||m.kind!==(i%2?'E':'B')||typeof m.acknowledged!=='boolean')fail();
    if(m.acknowledged){if(!number(m.roundTripMs)||!number(m.qpcMs)||markers[i]?.qpcMs!==m.qpcMs||markers[i]?.kind!==m.kind)fail();}
    else if(m.qpcMs!==null||m.roundTripMs!==null)fail();
    return {id:m.id,kind:m.kind,acknowledged:m.acknowledged,qpcMs:m.qpcMs,roundTripMs:m.roundTripMs};
  });
  for(const p of report.positions){if(!integer(p.block)||!blocks[p.block]||p.blockCompleted!==blocks[p.block].completed
    ||(p.blockCompleted&&p.audioSampleEnd!==blocks[p.block].sampleEnd))fail();}
  const completed=blocks.filter((b:any)=>b.completed);
  if(completed.length!==report.capture.processedBlocks||completed.reduce((sum:number,b:any)=>sum+b.samples,0)!==report.capture.processedSamples)fail();
  if(blocks.some((b:any,i:number)=>!b.completed&&i!==blocks.length-1))fail();
  for(const b of completed)if(b.decodeCalls!==decodes.filter((d:any)=>d.block===b.sequence).length
    ||b.rawHits!==report.positions.filter((p:any)=>p.block===b.sequence).length)fail();
  if(decodes.length!==report.inference.decodeCalls)fail();
  if(report.state==='COMPLETED'&&(blocks.length!==completed.length||!value.channelHealthy))fail();
  return {schema:1,trialId:value.trialId,clock:'QPC_RELATIVE_MS',signalDomain:'POST_FIR_MONO_16000',channelHealthy:value.channelHealthy,
    blocks,decodes,markers,hostMarkers};
}
