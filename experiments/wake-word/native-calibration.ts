// Read-only readiness audit. Does not read audio, launch engines or authorize capture.
import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha,localPath } from './benchmark-contract.js';
import { liveConfiguration,liveKeyword,parseLiveFlags } from './native-live-config.js';
import { falseNegativeReport,compareFnSessions } from './native-fn.js';
import { SpikeError } from './core.js';

const thresholds=[.15,.10,.05] as const;
const kinds=['POSITIVE','SILENCE','SIMILAR'] as const;
function fail(code='CALIBRATION_INPUT_INVALID'):never{throw new SpikeError(code);}
function keys(v:any,allowed:string[]){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==allowed.length
    ||Object.keys(v).some(k=>!allowed.includes(k)))fail();
}
function hash(v:any){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();return v;}
function json(bytes:Uint8Array){
  if(bytes.byteLength>4*1024*1024)fail('CALIBRATION_REPORT_TOO_LARGE');
  try{return JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,''));}catch{fail();}
}
export function calibrationDesign(){
  const trials=kinds.flatMap(kind=>thresholds.map(threshold=>{
    let replaySupported=true;
    try{parseLiveFlags(['--replay','LOCAL_AUTHORIZED_WAV','--threshold',String(threshold)]);}catch{replaySupported=false;}
    return {kind,configuration:liveConfiguration(threshold),keywordSha256:sha(liveKeyword(threshold)),
      spotterThresholdFloat32:Math.fround(threshold),existingReplaySupported:replaySupported};
  }));
  const protocol={schema:1,mode:'COLD',trials,margin:{beforeMs:250,afterMs:1000},
    sampleDomain:'POST_FIR_MONO_16000',blockSamples:1600,
    requiredIdentity:['containerSha256','canonicalPcmSha256','processedPcmSha256','sampleCount','modelHashes','runtimeHashes','annotationSha256'],
    order:'SEQUENTIAL_FRESH_PROCESS_PER_TRIAL',paddingSamples:0,normalization:false,
    runtimeEntry:'calibration-session.ts',recordingImplemented:true,replayExtensionImplemented:true,qpcToPcmConversionImplemented:true};
  return {state:'IMPLEMENTED_WINDOWS_ACCEPTANCE_PENDING',designSha256:sha(JSON.stringify(protocol)),protocol,
    blockers:['EXPLICIT_CONSENT_REQUIRED_PER_CAPTURE','WINDOWS_BUILD_AND_ACOUSTIC_ACCEPTANCE_PENDING'],
    acceptance:'NO_PRODUCTION_GO_NO_ACOUSTIC_RESULT'};
}
export interface Evidence {id:'A1'|'A2';sha256:string;bytes:Uint8Array}
export function auditCalibrationEvidence(sources:Evidence[]){
  if(!Array.isArray(sources)||sources.length<1||sources.length>2)fail();
  const ids=new Set<string>(),digests=new Set<string>(),trials=new Set<string>();
  const analyzed:any[]=[];
  const evidence=[...sources].sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(source=>{
    if(!['A1','A2'].includes(source.id)||ids.has(source.id)||!(source.bytes instanceof Uint8Array))fail();
    ids.add(source.id);const expected=hash(source.sha256);
    if(sha(source.bytes)!==expected)fail('CALIBRATION_HASH_MISMATCH');
    if(digests.has(expected))fail('CALIBRATION_DUPLICATE_EVIDENCE');digests.add(expected);
    let analysis:any;
    try{analysis=falseNegativeReport(json(source.bytes));}catch{fail('CALIBRATION_EVIDENCE_INVALID');}
    if(analysis.state==='NOT_EVALUABLE')return {id:source.id,reportSha256:expected,state:'NOT_EVALUABLE',
      reason:'H15_DIAGNOSTICS_UNAVAILABLE',rawHits:null,acceptedDetections:null,associatedPronunciations:null};
    if(trials.has(analysis.trialId))fail('CALIBRATION_DUPLICATE_EVIDENCE');trials.add(analysis.trialId);analyzed.push(analysis);
    return {id:source.id,reportSha256:expected,state:'DIAGNOSED',trialId:analysis.trialId,trialComplete:analysis.trialComplete,
      rawHits:analysis.events.length,acceptedDetections:analysis.events.filter((e:any)=>e.accepted).length,
      suppressedHits:analysis.events.filter((e:any)=>!e.accepted).length,associatedPronunciations:analysis.counts.MATCHED,
      evaluableAttempts:analysis.evaluableAttempts,counts:analysis.counts,sensitivityEstimate:analysis.sensitivityEstimate};
  });
  let betweenLiveSessions:any=null;
  if(analyzed.length===2){try{betweenLiveSessions=compareFnSessions(analyzed[0],analyzed[1]);}catch{fail('CALIBRATION_EVIDENCE_INCOMPARABLE');}}
  const result={schema:1,state:'AUDITED_NOT_CALIBRATED',evidence,betweenLiveSessions,
    sameAudioEvidence:'NOT_PROVEN_LIVE_CAPTURES_ARE_NOT_REPLAY',design:calibrationDesign()};
  return {...result,auditSha256:sha(JSON.stringify(result))};
}
async function readJsonFile(path:string){
  if(!path.toLowerCase().endsWith('.json'))fail();
  const file=await localPath(path),info=await stat(file);
  if(!info.isFile()||info.size>4*1024*1024)fail('CALIBRATION_REPORT_TOO_LARGE');
  return readFile(file);
}
export async function auditCalibrationIndex(path:string){
  const index=json(await readJsonFile(path));keys(index,['schema','reports']);
  if(index.schema!==1||!Array.isArray(index.reports)||index.reports.length<1||index.reports.length>2)fail();
  for(const r of index.reports){keys(r,['id','path','sha256']);hash(r.sha256);
    if(!['A1','A2'].includes(r.id)||typeof r.path!=='string'||!r.path)fail();}
  // Sequential metadata reads only. Existing localPath rejects resolved paths outside .local.
  const sources:Evidence[]=[];
  for(const r of index.reports)sources.push({id:r.id,sha256:r.sha256,bytes:await readJsonFile(r.path)});
  return auditCalibrationEvidence(sources);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [operation,path,...extra]=process.argv.slice(2);if(extra.length)fail();
    if(operation==='design'&&!path)console.log(JSON.stringify(calibrationDesign()));
    else if(operation==='audit'&&path)console.log(JSON.stringify(await auditCalibrationIndex(path)));else fail();
  }catch(error){const allowed=['CALIBRATION_INPUT_INVALID','CALIBRATION_REPORT_TOO_LARGE','CALIBRATION_HASH_MISMATCH','CALIBRATION_DUPLICATE_EVIDENCE','CALIBRATION_EVIDENCE_INVALID','CALIBRATION_EVIDENCE_INCOMPARABLE'];
    console.log(JSON.stringify({state:'FAILED',code:error instanceof SpikeError&&allowed.includes(error.code)?error.code:'CALIBRATION_INPUT_INVALID'}));process.exitCode=2;}
}
