// Explicit local-only calibration lifecycle. No Atlas imports or network API.
import { mkdir,lstat,readdir,readFile,writeFile,unlink,access } from 'node:fs/promises';
import { resolve,relative,isAbsolute,sep,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha } from './benchmark-contract.js';
import { livePreflight,runLiveChild,cleanLiveReport } from './native-live.js';
import { CalibrationAlignmentError,auditCalibrationAlignment } from './calibration-alignment.js';
import { NativeMarkers } from './native-fn-diagnostics.js';
import { bindCalibrationWindows,validatePcm,retention,retentionMs,maxCalibrationSamples,checkedKind,checkHash,calibrationThresholds,calibrationFormat,
  associateCalibration,validateCalReplay,validateCalCapture,captureSeconds,sessionSeconds,replaySeconds,digest,same,fail,type Kind } from './calibration-contract.js';
export const calibrationRoot=resolve(import.meta.dirname,'../../.local/wake-word-spike/calibration');
const localRoot=resolve(import.meta.dirname,'../../.local');
function id(value:string){if(!/^[a-f0-9]{32}$/.test(value))fail('CAL_ID_INVALID');return value;}
export async function safeLocal(path:string,missing=false){
  const full=resolve(path),rel=relative(localRoot,full);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('CAL_PATH_INVALID');
  let current=localRoot;
  for(const part of ['',...rel.split(sep)]){
    if(part)current=join(current,part);
    try{const s=await lstat(current);if(s.isSymbolicLink()||(!s.isDirectory()&&current!==full))fail('CAL_PATH_INVALID');}
    catch(e){if(missing&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  }
  return full;
}
const folder=(session:string)=>join(calibrationRoot,'captures',id(session));
async function exists(path:string){try{await access(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function json(path:string){
  await safeLocal(path);const s=await lstat(path);if(!s.isFile()||s.size>4*1024*1024)fail('CAL_JSON_INVALID');
  try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}catch{fail('CAL_JSON_INVALID');}
}
async function saveJson(path:string,value:any){await safeLocal(path,true);await writeFile(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});}
function validateConsent(c:any,session:string,now=Date.now()){
  if(c?.schema!==1||c.contract!=='ATLAS_CALIBRATION_F32LE_V1'||c.trialId!==id(session)||c.consent!=='EXPLICIT_PER_CAPTURE')fail('CAL_CONSENT_INVALID');
  sessionSeconds(c);return retention(c.createdAtUtc,c.expiresAtUtc,now);
}
export async function retentionStatus(now=Date.now()){
  const root=join(calibrationRoot,'captures');await safeLocal(root,true);if(!await exists(root))return [];
  const rows=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!/^[a-f0-9]{32}$/.test(entry.name))continue;
    let state='INVALID_METADATA',acousticPresent=true;
    try{const dir=folder(entry.name);await safeLocal(dir);acousticPresent=await exists(join(dir,'capture.f32le'));
      state=validateConsent(await json(join(dir,'consent.json')),entry.name,now);}
    catch{/* Fail closed and expose only an identifier/status, never filesystem errors. */}
    rows.push({sessionId:entry.name,acousticPresent,state,warning:acousticPresent&&state!=='WITHIN_RETENTION'});
  }
  return rows;
}
export async function eraseAcoustic(session:string,confirmation:string){
  id(session);if(confirmation!==`BORRAR ${session}`)fail('CAL_DELETE_CONSENT_REQUIRED');
  const dir=folder(session);const c=await json(join(dir,'consent.json'));
  // Deletion is allowed even after expiry; never follows links or deletes recursively.
  validateConsent(c,session);const file=await safeLocal(join(dir,'capture.f32le'));
  if(!(await lstat(file)).isFile())fail('CAL_PATH_INVALID');await unlink(file);
  if(await exists(file))fail('CAL_DELETE_FAILED');
  return {state:'ACOUSTIC_ABSENT',sessionId:session,metadataRetained:true,physicalErasureGuaranteed:false};
}
export async function loadCalibrationSession(session:string,now=Date.now()){
  const dir=folder(session),consent=await json(join(dir,'consent.json'));
  if(validateConsent(consent,session,now)!=='WITHIN_RETENTION')fail('CAL_RETENTION_EXPIRED');
  const m=await json(join(dir,'session.json'));
  if(m?.schema!==1||m.contract!==consent.contract||m.trialId!==session||m.kind!==consent.kind||m.createdAtUtc!==consent.createdAtUtc
    ||m.expiresAtUtc!==consent.expiresAtUtc||m.state!=='COMPLETE'||sessionSeconds(m)!==sessionSeconds(consent)||!same(m.format,calibrationFormat)||!Number.isSafeInteger(m.samples)||m.samples<1||m.samples>maxCalibrationSamples)fail('CAL_SESSION_INVALID');
  replaySeconds(m);
  for(const key of ['pcmSha256','reportSha256','annotationSha256','lockSha256'])checkHash(m[key]);
  const reportPath=await safeLocal(join(dir,'capture.json')),bytes=await readFile(reportPath);
  if(sha(bytes)!==m.reportSha256)fail('CAL_REPORT_HASH_MISMATCH');
  const r=await json(reportPath);validateCalCapture(r,m.kind,sessionSeconds(m)); // Calibration duration only; published Hito 1.5 remains pinned to 60 s.
  if(r.capture.processedSamples!==m.samples||!same(r.modelHashes,m.modelHashes)||r.fnDiagnostics.trialId!==session)fail('CAL_SESSION_INVALID');
  if(r.calibration?.schema!==1||r.calibration.mode!=='CAPTURE'||r.calibration.persisted!==true||r.calibration.sha256!==m.pcmSha256||r.calibration.samples!==m.samples)fail('CAL_SESSION_INVALID');
  const windows=bindCalibrationWindows(r,m.kind);
  if(!same(windows,m.windows)||digest(windows)!==m.annotationSha256)fail('CAL_ANNOTATION_INVALID');
  const pcm=await safeLocal(join(dir,'capture.f32le')),size=await lstat(pcm);
  if(!size.isFile()||size.size!==m.samples*4)fail('CAL_PCM_LENGTH_INVALID');
  const audio=await readFile(pcm);try{validatePcm(audio,m.pcmSha256,m.samples);}finally{audio.fill(0);}
  return {manifest:m,pcm};
}
async function prompt(text:string){
  if(!process.stdin.isTTY)fail('CAL_INTERACTIVE_CONSENT_REQUIRED');
  const rl=createInterface({input:process.stdin,output:process.stderr});
  try{return await rl.question(text);}finally{rl.close();}
}
export async function requireConsent(kind:Kind,trial:string,ask:(text:string)=>Promise<string>=prompt){
  const expected=`CAPTURAR ${kind} ${id(trial)}`;
  const answer=await ask(`Se conservarán ${captureSeconds(kind)} s de PCM privado hasta 7 días. Sin envío externo. Escribí ${expected}: `);
  if(answer!==expected)fail('CAL_CAPTURE_CONSENT_REQUIRED');
}
// Fixed JSON basenames only. Never loadCalibrationSession here: that reads PCM.
export async function auditCalibrationSession(session:string,kind:Kind){
  const dir=folder(session),report=await json(join(dir,'capture.json'));
  let failureRecorded=false;
  if(await exists(join(dir,'failure.json'))){
    const failure=await json(join(dir,'failure.json'));
    if(failure?.sessionId!==session||failure?.schema!==1)fail('CAL_SESSION_INVALID');
    failureRecorded=true;
  }
  if(report.fnDiagnostics?.trialId!==session)fail('CAL_SESSION_INVALID');
  return {sessionId:session,failureRecorded,...auditCalibrationAlignment(report,kind)};
}
async function capture(exe:string,lock:string,kind:Kind){
  if(process.platform!=='win32'||process.arch!=='x64')fail('CAL_WINDOWS_REQUIRED');
  const statuses=await retentionStatus();if(statuses.some(s=>s.warning))fail('CAL_RETENTION_REVIEW_REQUIRED');
  const seconds=captureSeconds(kind),ready=await livePreflight(exe,lock,undefined,.15),trial=randomBytes(16).toString('hex');
  await requireConsent(kind,trial);
  const dir=folder(trial);await safeLocal(dir,true);await mkdir(dir,{recursive:true,mode:0o700});
  // Windows ignores POSIX mode bits. Verify inherited ACLs before any audio is captured.
  try{await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./calibration-private-directory.ps1',import.meta.url)),'-Directory',dir],{timeout:10000,maxBuffer:4096});}
  catch{fail('CAL_PRIVATE_DIRECTORY_UNVERIFIED');}
  const now=Date.now(),consent={schema:1,contract:'ATLAS_CALIBRATION_F32LE_V1',trialId:trial,kind,requestedSeconds:seconds,consent:'EXPLICIT_PER_CAPTURE',
    createdAtUtc:new Date(now).toISOString(),expiresAtUtc:new Date(now+retentionMs).toISOString()};
  await saveJson(join(dir,'consent.json'),consent);
  const markers=new NativeMarkers(trial),controller=new AbortController(),stop=()=>controller.abort();
  const rl=createInterface({input:process.stdin,output:process.stderr});
  rl.on('line',line=>{if(kind!=='SILENCE'&&(line==='b'||line==='e')){try{if(!markers.mark(line==='b'?'B':'E'))console.error('MARKER_NOT_READY');}catch{stop();}}else stop();});
  rl.on('close',stop);process.on('SIGINT',stop);
  let cleanupVerified=false;
  try{
    const args=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n=>resolve(ready.root,'model',n));
    const raw=await runLiveChild(ready.exe,[...args,ready.keyword,'COLD',String(seconds),'--threshold','0.15','--detail','--diagnostic-windows',trial,
      '--calibration-save',join(dir,'capture.f32le'),'--calibration-kind',kind,'--capture-consent',trial],seconds,controller.signal,stage=>console.error(stage),undefined,undefined,markers);
    const r=cleanLiveReport(raw.report,ready.expected,'COLD','MICROPHONE',seconds,.15,{trialId:trial,host:markers.snapshot()});
    cleanupVerified=r.cleanup?.microphoneReleased===true&&r.cleanup?.comReleased===true&&r.cleanup?.engineReleased===true&&r.cleanup?.threadsJoined===true;
    const c=raw.report.calibration;
    if(raw.exitCode!==0||r.state!=='COMPLETED'){await saveJson(join(dir,'incomplete-capture.json'),r);fail('CAL_CAPTURE_INCOMPLETE');}
    if(c?.schema!==1||c.mode!=='CAPTURE'||c.persisted!==true||c.samples!==r.capture.processedSamples)fail('CAL_CAPTURE_INCOMPLETE');
    const pcmSha256=checkHash(c.sha256),file=await safeLocal(join(dir,'capture.f32le')),audio=await readFile(file);
    try{validatePcm(audio,pcmSha256,c.samples);}finally{audio.fill(0);}
    const reportBytes=Buffer.from(JSON.stringify({...r,calibration:{schema:1,mode:'CAPTURE',persisted:true,samples:c.samples,sha256:pcmSha256}})+'\n');await safeLocal(join(dir,'capture.json'),true);await writeFile(join(dir,'capture.json'),reportBytes,{flag:'wx',mode:0o600});
    const windows=bindCalibrationWindows(r,kind);
    const manifest={...consent,state:'COMPLETE',format:calibrationFormat,samples:c.samples,pcmSha256,reportSha256:sha(reportBytes),windows,annotationSha256:digest(windows),
      modelHashes:r.modelHashes,lockSha256:sha(await readFile(await safeLocal(lock)))};
    await saveJson(join(dir,'session.json'),manifest);
    return {state:'CAPTURE_SAVED',sessionId:trial,samples:manifest.samples,pcmSha256,expiresAtUtc:consent.expiresAtUtc};
  }catch(e){try{await saveJson(join(dir,'failure.json'),{schema:1,state:'FAILED_OR_CANCELLED',cleanupVerified,sessionId:trial,...(e instanceof CalibrationAlignmentError?{code:e.code,diagnostics:e.diagnostics}:{})});}catch{/* Never replace the original failure or silently delete acoustic data. */}throw e;}
  finally{process.removeListener('SIGINT',stop);rl.close();console.error(`CAL_SESSION ${trial} — verificar status; eliminar manualmente cualquier PCM parcial.`);}
}
async function replay(exe:string,lock:string,sessionId:string,threshold:number,signal:AbortSignal,frozen:string){
  const {manifest:m,pcm}=await loadCalibrationSession(sessionId);
  if(digest(m)!==frozen)fail('CAL_SESSION_CHANGED');
  const ready=await livePreflight(exe,lock,undefined,threshold);
  if(!same(ready.expected.modelHashes,m.modelHashes)||sha(await readFile(await safeLocal(lock)))!==m.lockSha256)fail('CAL_IDENTITY_MISMATCH');
  const args=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n=>resolve(ready.root,'model',n));
  const raw=await runLiveChild(ready.exe,[...args,ready.keyword,'COLD',String(sessionSeconds(m)),'--threshold',String(threshold),'--detail',
    '--calibration-replay',pcm,'--calibration-samples',String(m.samples),'--calibration-sha',m.pcmSha256],replaySeconds(m),signal);
  const r=validateCalReplay(raw.report,ready.expected,m,threshold);if(raw.exitCode!==0)fail('CAL_REPLAY_INCOMPLETE');
  if(digest((await loadCalibrationSession(sessionId)).manifest)!==frozen)fail('CAL_SESSION_CHANGED'); // Revalidate after the actual Feed-boundary hash.
  return {manifest:m,report:r,summary:associateCalibration(r,m)};
}
async function matrix(exe:string,lock:string,positive:string,silence:string,similar:string,runId:string){
  if(process.platform!=='win32'||process.arch!=='x64')fail('CAL_WINDOWS_REQUIRED');id(runId);
  const selections=[{kind:'POSITIVE',id:positive},{kind:'SILENCE',id:silence},{kind:'SIMILAR',id:similar}];
  if(new Set(selections.map(s=>s.id)).size!==3)fail('CAL_SESSION_INVALID');
  const frozen=new Map<string,string>();
  for(const s of selections){const m=(await loadCalibrationSession(s.id)).manifest;if(m.kind!==s.kind)fail('CAL_KIND_INVALID');frozen.set(s.id,digest(m));}
  const out=join(calibrationRoot,'runs',runId);await safeLocal(out,true);if(await exists(out))fail('CAL_RUN_EXISTS');await mkdir(out,{recursive:true,mode:0o700});
  const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);
  const rows:any[]=[];let modelIdentity:string|undefined;
  try{for(const s of selections)for(const t of calibrationThresholds){
    if(controller.signal.aborted)fail('CAL_CANCELLED');
    const result=await replay(exe,lock,s.id,t,controller.signal,frozen.get(s.id)!);
    const identity=digest(result.manifest.modelHashes);if(modelIdentity&&modelIdentity!==identity)fail('CAL_IDENTITY_MISMATCH');modelIdentity=identity;
    await saveJson(join(out,`${s.kind}-${t}.json`),{schema:1,sessionId:s.id,pcmSha256:result.manifest.pcmSha256,report:result.report,summary:result.summary});
    rows.push({sessionId:s.id,pcmSha256:result.manifest.pcmSha256,samples:result.manifest.samples,requestedSeconds:sessionSeconds(result.manifest),annotationSha256:result.manifest.annotationSha256,...result.summary});
  }}finally{process.removeListener('SIGINT',stop);}
  for(const row of rows){const reference=rows.find(r=>r.kind===row.kind&&r.threshold===.15)!;
    row.deltaFromReference={associatedPronunciations:row.associatedPronunciations===null?null:row.associatedPronunciations-reference.associatedPronunciations,
      falsePositives:row.falsePositives-reference.falsePositives,rawHits:row.rawHits-reference.rawHits};}
  const result={schema:1,state:'NINE_EXPERIMENTAL_EVALUATIONS_COMPLETE',runId,referenceThreshold:.15,modelIdentity,rows,acceptance:'WINDOWS_ACOUSTIC_REVIEW_REQUIRED_NO_PRODUCTION_GO'};
  await saveJson(join(out,'matrix.json'),{...result,integritySha256:digest(result)});
  return {state:result.state,runId,rows:rows.map(r=>({kind:r.kind,threshold:r.threshold,associatedPronunciations:r.associatedPronunciations,
    omissions:r.omissions,duplicates:r.duplicates,rawHits:r.rawHits,falsePositives:r.falsePositives})),acceptance:result.acceptance};
}
export function compareCalibrationMatrices(a:any,b:any){
  for(const r of [a,b]){const {integritySha256,...body}=r??{};
    id(r.runId);checkHash(r.modelIdentity);
    if(checkHash(integritySha256)!==digest(body)||r.schema!==1||r.state!=='NINE_EXPERIMENTAL_EVALUATIONS_COMPLETE'||r.referenceThreshold!==.15||!Array.isArray(r.rows)||r.rows.length!==9)fail('CAL_MATRIX_INVALID');}
  if(a.runId===b.runId)fail('CAL_INDEPENDENT_RUNS_REQUIRED');
  if(a.modelIdentity!==b.modelIdentity)fail('CAL_IDENTITY_MISMATCH');
  const keys=new Set();
  for(let i=0;i<9;i++){
    const x=a.rows[i],y=b.rows[i],key=`${x.kind}-${x.threshold}`;
    checkedKind(x.kind);if(!calibrationThresholds.includes(x.threshold)||keys.has(key))fail('CAL_MATRIX_INVALID');keys.add(key);
    replaySeconds(x);replaySeconds(y);if(sessionSeconds(x)!==sessionSeconds(y))fail('CAL_RESULTS_INCONSISTENT');
    id(x.sessionId);for(const k of ['samples','rawHits','detections','suppressedHits','duplicates','falsePositives'])if(!Number.isSafeInteger(x[k])||x[k]<0)fail('CAL_MATRIX_INVALID');
    if(x.rawHits!==x.detections+x.suppressedHits||x.samples<1||x.samples>maxCalibrationSamples)fail('CAL_MATRIX_INVALID');
    for(const k of ['sessionId','kind','threshold','pcmSha256','samples','annotationSha256','recognitionSignature','rawHits','detections','suppressedHits','associatedPronunciations','omissions','duplicates','falsePositives'])
      if(x[k]===undefined||!same(x[k],y[k]))fail('CAL_RESULTS_INCONSISTENT');
    checkHash(x.recognitionSignature);checkHash(x.pcmSha256);checkHash(x.annotationSha256);
  }
  return {state:'REPRODUCIBLE_ON_SAME_PCM',cells:9,productionGo:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [op,...args]=process.argv.slice(2);let result:any;
    if(op==='capture'&&args.length===3)result=await capture(args[0]!,args[1]!,checkedKind(args[2]!));
    else if(op==='matrix'&&args.length===6)result=await matrix(args[0]!,args[1]!,args[2]!,args[3]!,args[4]!,args[5]!);
    else if(op==='audit'&&args.length===2)result=await auditCalibrationSession(id(args[0]!),checkedKind(args[1]!));
    else if(op==='status'&&!args.length)result={state:'RETENTION_STATUS',sessions:await retentionStatus()};
    else if(op==='delete'&&args.length===1){const session=id(args[0]!);result=await eraseAcoustic(session,await prompt(`Escribí BORRAR ${session}: `));}
    else if(op==='compare'&&args.length===2)result=compareCalibrationMatrices(await json(args[0]!),await json(args[1]!));else fail('CAL_ARGUMENT_INVALID');
    console.log(JSON.stringify(result));
    if(op==='audit'&&result.state!=='ALIGNMENT_VALID')process.exitCode=2;
  }catch(e){const code=(e as {code?:string}).code;console.log(JSON.stringify({state:'FAILED',code:code&&/^CAL_[A-Z_]+$/.test(code)?code:'CAL_OPERATION_FAILED',productionGo:false,...(e instanceof CalibrationAlignmentError?{diagnostics:e.diagnostics}:{})}));process.exitCode=2;}
}
