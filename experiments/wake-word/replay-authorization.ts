// Private explicit runtime authorization. Metadata only; never reads acoustic data.
import { sha,sdkHashes } from './benchmark-contract.js';
import { runtimeCommit,artifactSha256 } from './native-benchmark.js';
import { liveConfiguration,liveKeyword } from './native-live-config.js';
import { checkHash,digest,same,retention,calibrationThresholds,fail } from './calibration-contract.js';
export type ReplayTimingMode='STRICT_REALTIME'|'ACOUSTIC_BACKPRESSURE';
export function replayTimingMode(value:unknown):ReplayTimingMode{
  if(value!=='STRICT_REALTIME'&&value!=='ACOUSTIC_BACKPRESSURE')fail('CAL_TIMING_MODE_INVALID');return value as ReplayTimingMode;
}
export function historicalTimingMode(value:unknown){return value===undefined?'STRICT_REALTIME':replayTimingMode(value);}
const lockKeys=['schema','kind','version','commit','artifactSha256','sourceSha256','executableSha256','calibrationSourceSha256','diagnosticSourceSha256','referenceSourceSha256','coreSourceSha256'];
export function checkedReplayLock(text:string){
  if(typeof text!=='string'||text.length>8192)fail('CAL_AUTHORIZATION_INVALID');
  let lock:any;try{lock=JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('CAL_AUTHORIZATION_INVALID');}
  if(!same(Object.keys(lock).sort(),lockKeys.slice().sort())||lock.schema!==1||lock.kind!=='NATIVE_LIVE'||lock.version!=='2.0.0'||lock.commit!==runtimeCommit||lock.artifactSha256!==artifactSha256)fail('CAL_AUTHORIZATION_INVALID');
  for(const key of lockKeys.filter(k=>k.endsWith('Sha256')))checkHash(lock[key]);
  return lock;
}
const configuration=()=>calibrationThresholds.map(threshold=>({threshold,configuration:liveConfiguration(threshold),keywordSha256:sha(liveKeyword(threshold))}));
export function authorizationBinding(manifest:any,captureLockText:string,replayLockText:string,executableSha256:string,timingMode:ReplayTimingMode){
  replayTimingMode(timingMode);
  if(!/^[a-f0-9]{32}$/.test(manifest.trialId))fail('CAL_ID_INVALID');
  for(const key of ['pcmSha256','reportSha256','annotationSha256','lockSha256'])checkHash(manifest[key]);
  const old=checkedReplayLock(captureLockText),next=checkedReplayLock(replayLockText);
  if(sha(captureLockText)!==manifest.lockSha256||next.executableSha256!==checkHash(executableSha256))fail('CAL_IDENTITY_MISMATCH');
  for(const k of ['referenceSourceSha256','coreSourceSha256','diagnosticSourceSha256'])if(old[k]!==next[k])fail('CAL_IDENTITY_MISMATCH');
  const models=manifest.modelHashes;
  if(!models||!same(Object.keys(models).sort(),['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].sort()))fail('CAL_IDENTITY_MISMATCH');
  Object.values(models).forEach(checkHash);
  return {datasetId:manifest.trialId,manifestSha256:digest(manifest),pcmSha256:manifest.pcmSha256,reportSha256:manifest.reportSha256,
    annotationSha256:manifest.annotationSha256,captureLockSha256:manifest.lockSha256,captureLockText,
    replayLockSha256:sha(replayLockText),replayLockText,executableSha256,modelHashes:models,runtime:{version:'2.0.0',commit:runtimeCommit,dllHashes:sdkHashes},
    recognition:configuration(),timingMode};
}
export function createReplayAuthorization(manifest:any,captureLockText:string,replayLockText:string,executableSha256:string,timingMode:ReplayTimingMode,now=Date.now()){
  if(retention(manifest.createdAtUtc,manifest.expiresAtUtc,now)!=='WITHIN_RETENTION')fail('CAL_RETENTION_EXPIRED');
  const body={schema:1,contract:'ATLAS_PRIVATE_REPLAY_AUTHORIZATION_V1',consent:'EXPLICIT_PER_DATASET_RUNTIME_MODE',
    createdAtUtc:new Date(now).toISOString(),expiresAtUtc:manifest.expiresAtUtc,
    ...authorizationBinding(manifest,captureLockText,replayLockText,executableSha256,timingMode)};
  return {...body,integritySha256:digest(body)};
}
export function validateReplayAuthorization(annex:any,pinnedSha256:string,manifest:any,replayLockText:string,executableSha256:string,mode:ReplayTimingMode,now=Date.now()){
  if(!annex||typeof annex!=='object')fail('CAL_AUTHORIZATION_INVALID');
  // Recreate the complete closed contract; unexpected fields, dates and hashes fail.
  const c=Date.parse(annex.createdAtUtc);
  if(!Number.isFinite(c)||c>now||c<Date.parse(manifest.createdAtUtc)||new Date(c).toISOString()!==annex.createdAtUtc)fail('CAL_AUTHORIZATION_INVALID');
  if(now>=Date.parse(manifest.expiresAtUtc))fail('CAL_RETENTION_EXPIRED');
  const expected=createReplayAuthorization(manifest,annex.captureLockText,replayLockText,executableSha256,mode,c);
  if(checkHash(pinnedSha256)!==expected.integritySha256||!same(annex,expected))fail('CAL_AUTHORIZATION_INVALID');
  return {authorizationSha256:pinnedSha256,captureLockSha256:manifest.lockSha256,replayLockSha256:sha(replayLockText),executableSha256,timingMode:mode};
}
// Explicit replay-only metrics, separate from audio-sample time and CPU time.
export function cleanReplayTiming(raw:any,expected:ReplayTimingMode,allowHistorical=false){
  replayTimingMode(expected);
  if(raw===undefined){if(allowHistorical&&expected==='STRICT_REALTIME')return {timingMode:expected,metricsAvailable:false};fail('CAL_TIMING_MODE_INVALID');}
  const keys=['timingMode','waitCount','capacityWaitWallMs','maxCapacityWaitWallMs','totalWallMs','cancelled'];
  if(!raw||!same(Object.keys(raw).sort(),keys.sort())||raw.timingMode!==expected||typeof raw.cancelled!=='boolean')fail('CAL_TIMING_MODE_INVALID');
  for(const key of ['capacityWaitWallMs','maxCapacityWaitWallMs','totalWallMs'])if(typeof raw[key]!=='number'||!Number.isFinite(raw[key])||raw[key]<0||raw[key]>86400000)fail('CAL_REPLAY_CONTRACT_INVALID');
  if(!Number.isSafeInteger(raw.waitCount)||raw.waitCount<0||raw.waitCount>1840||raw.maxCapacityWaitWallMs>raw.capacityWaitWallMs+1e-6||raw.capacityWaitWallMs>raw.totalWallMs+1e-6
    ||(raw.waitCount===0&&(raw.capacityWaitWallMs!==0||raw.maxCapacityWaitWallMs!==0))
    ||(expected==='STRICT_REALTIME'&&(raw.waitCount!==0||raw.capacityWaitWallMs!==0||raw.maxCapacityWaitWallMs!==0)))fail('CAL_REPLAY_CONTRACT_INVALID');
  return {...raw,metricsAvailable:true};
}
