// Experimental local supervisor. No sockets, microphone APIs, audio persistence or Atlas imports.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { calibrationBlockLimit } from './calibration-limits.js';
import { NativeMarkers, validateFnDiagnostics, type HostMarker } from './native-fn-diagnostics.js';
import { createInterface } from 'node:readline';
import { artifactSha256, runtimeCommit } from './native-benchmark.js';
import { input, localPath, sdkHashes, sha, validateTrial } from './benchmark-contract.js';
import { SpikeError } from './core.js';
import { liveConfiguration, liveKeyword, parseLiveFlags } from './native-live-config.js';

const codes = new Set(['CALIBRATION_REPLAY_TIMEOUT','CALIBRATION_SEQUENCE_INVALID','CALIBRATION_PCM_INVALID','CALIBRATION_WRITE_FAILED','CALIBRATION_PATH_INVALID','CALIBRATION_REPLAY_FAILED','DIAGNOSTIC_CHANNEL_UNAVAILABLE','DIAGNOSTIC_CHANNEL_FAILED','DIAGNOSTIC_LIMIT','MARKER_PROTOCOL_INVALID','MARKER_NOT_ACTIVE','CAPTURE_COMPLETED','CAPTURE_INCOMPLETE','ARGUMENT_INVALID','EVENT_FAILED','WALL_CLOCK_FAILED',
  'DLL_LOCATION_FAILED','DLL_LOCATION_MISMATCH','SDK_HASH_MISMATCH','RUNTIME_VERSION_MISMATCH','HASH_FAILED','INPUT_FILE_INVALID',
  'COM_INITIALIZATION_FAILED','DEVICE_ENUMERATION_FAILED','MICROPHONE_UNAVAILABLE','CAPTURE_ACTIVATION_FAILED',
  'CAPTURE_FORMAT_FAILED','CAPTURE_FORMAT_UNSUPPORTED','CAPTURE_INITIALIZATION_FAILED','CAPTURE_BUFFER_FAILED',
  'CAPTURE_BUFFER_UNSUPPORTED','CAPTURE_EVENT_FAILED','CAPTURE_SERVICE_FAILED','CAPTURE_START_FAILED','CAPTURE_STOP_FAILED',
  'CAPTURE_WAIT_FAILED','CAPTURE_PACKET_FAILED','CAPTURE_READ_FAILED','CAPTURE_PACKET_INVALID','CAPTURE_RELEASE_FAILED',
  'CAPTURE_TIMESTAMP_INVALID','CAPTURE_DISCONTINUITY','CAPTURE_SAMPLE_INVALID','CAPTURE_CLOCK_FAILED','CAPTURE_FAILED',
  'AUDIO_OVERFLOW','ASSEMBLER_STOPPED','MODEL_LOAD_FAILED','STREAM_FAILED','WARMUP_TIMEOUT','RESET_FAILED','DECODE_LIMIT',
  'RESULT_FAILED','KEYWORD_ID_MISMATCH','POSITION_INVALID','HIT_LIMIT','AUDIO_SEQUENCE_ERROR','INFERENCE_WAIT_FAILED',
  'INFERENCE_FAILED','CONTROL_HANDLER_FAILED','CONTROL_WAIT_FAILED','PREPARATION_TIMEOUT','THREAD_OR_CONTROL_FAILED',
  'AUDIO_ACCOUNTING_FAILED','NATIVE_LIVE_FAILED','WAV_INVALID','WAV_FORMAT_REQUIRED','WAV_SAMPLE_COUNT_MISMATCH',
  'PCM_HASH_MISMATCH','PCM_MUTATED','REPLAY_FAILED']);
// Closed diagnostic code lookup; never expose an arbitrary Native string.
export const nativeDiagnosticCode=(value:unknown)=>typeof value==='string'&&codes.has(value)?value:null;
const stages = new Set(['PREPARING','CAPTURE_STARTED','CAPTURE_STOPPED','REPLAY_STARTED','REPLAY_STOPPED']);
function reject(): never { throw new SpikeError('NATIVE_LIVE_REPORT_INVALID'); }
function nums(value: any, keys: string[]) {
  const result: Record<string, number|null> = {};
  for (const key of keys) { const v=value?.[key]; if (v!==null && !(typeof v==='number' && Number.isFinite(v) && v>=0)) reject(); result[key]=v; }
  return result;
}
const bools=(value:any,keys:string[])=>Object.fromEntries(keys.map(key=>{if(typeof value?.[key]!=='boolean')reject();return[key,value[key]];}));
const same=(a:any,b:any)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());
export function cleanLiveReport(r:any, expected:any, mode:'COLD'|'WARM', source:'MICROPHONE'|'REPLAY', seconds:number, threshold=.25, diagnostic?:{trialId:string;host:HostMarker[]}):any {
  const effectiveConfiguration=liveConfiguration(threshold);
  if(r?.schema!==1 || !['COMPLETED','CANCELLED','FAILED'].includes(r.state))reject();
  if(r.state==='FAILED' && !r.backend)return {schema:1,state:'FAILED',code:codes.has(r.code)?r.code:'NATIVE_LIVE_FAILED'};
  if(seconds===180&&(mode!=='COLD'||!['MICROPHONE','REPLAY'].includes(source)||r?.calibration?.schema!==1
    ||r.calibration.mode!==(source==='MICROPHONE'?'CAPTURE':'REPLAY')||(source==='MICROPHONE'?threshold!==.15:![.15,.1,.05].includes(threshold))))reject();
  if(r.backend!=='NATIVE_LIVE' || r.mode!==mode || r.source!==source || !same(r.configuration,effectiveConfiguration)
    || !same(r.modelHashes,expected.modelHashes) || r.keywordSha256!==expected.keywordSha256
    || r.runtime?.version!=='2.0.0' || !Array.isArray(r.runtime.dlls) || r.runtime.dlls.length!==2
    || ['sherpa-onnx-c-api.dll','onnxruntime.dll'].some(name=>!r.runtime.dlls.some((d:any)=>d.name===name && d.sha256===sdkHashes[name])))reject();
  let thresholdEvidence=null;
  if(r.thresholdEvidence!==undefined){
    const value=r.thresholdEvidence?.spotterArgumentFloat32;
    if(!(value===null && r.state!=='COMPLETED') && value!==Math.fround(threshold))reject();
    thresholdEvidence={spotterArgumentFloat32:value};
  }else if(threshold!==.25)reject();
  const format=nums(r.format,['rate','channels','containerBits','validBits','selectedChannel','endpointBufferFrames']);
  if(!['PCM16','PCM24','PCM32','FLOAT32','FLOAT64'].includes(r.format.kind) || format.selectedChannel!==0 || Number(format.channels)>8)reject();
  const capture=nums(r.capture,['requestedSeconds','wallMs','framesReceived','framesConverted','unconvertedFrames','resampledSamples','enqueuedBlocks','processedSamples','processedBlocks','silentFrames','unprocessedSamples','overflows','discontinuities','initialDiscontinuities','sequenceErrors']);
  const buffer=nums(r.buffer,['queuedCapacity','decoderBlocks','assemblerBlocks','highWater','pendingAfterCleanup','abandonedBlocksOnFailure','maxQueueAgeMs','maxBlockEndLatencyMs']);
  const preparation={...nums(r.preparation,['initializationWallMs','wallMs','resetWallMs','syntheticBlocks','decodeCalls']),...bools(r.preparation,['newStream'])};
  const inference=nums(r.inference,['decodeCalls','firstDecodeWallMs','medianDecodeWallMs','p95DecodeWallMs','maxDecodeWallMs','maxBlockWallMs','processingWallMs','threadCpuMs','rtf']);
  const recognition=nums(r.recognition,['rawHits','detections','suppressedHits']);
  const cleanup={...nums(r.cleanup,['wallMs','microphoneReleaseWallMs','engineReleaseWallMs']),...bools(r.cleanup,['microphoneReleased','comReleased','engineReleased','threadsJoined'])};
  if(!Array.isArray(r.channels)||r.channels.length!==format.channels)reject();
  const channels=r.channels.map((v:any,i:number)=>{const m=nums(v,['channel','samples','rms','peak','clipped','nearZero']);if(m.channel!==i)reject();return m;});
  const memory=nums(r.memory,['residentStartBytes','residentEndBytes','peakResidentBytes','residentAfterCleanupBytes']);
  if(!Array.isArray(r.memory.residentWindows10s)||r.memory.residentWindows10s.length!==12)reject();
  const residentWindows10s=r.memory.residentWindows10s.map((v:any)=>nums({v},['v']).v);
  if(!Array.isArray(r.positions)||r.positions.length>1000)reject();
  const positions=r.positions.map((p:any)=>{
    if(!Array.isArray(p.timestampsSec)||!p.timestampsSec.length||p.timestampsSec.length>32)reject();
    return {...nums(p,['block','audioSampleEnd','startTimeSec','latencyFromBlockEndMs']),...bools(p,['blockCompleted']),
      timestampsSec:p.timestampsSec.map((v:any)=>nums({v},['v']).v),acousticLatencyMs:null};
  });
  let details:any=null;
  if(r.details!==null){
    if(!Array.isArray(r.details?.decodes)||r.details.decodes.length>10000||!Array.isArray(r.details.blocks)||r.details.blocks.length>calibrationBlockLimit(seconds))reject();
    details={decodes:r.details.decodes.map((d:any)=>nums(d,['block','wallMs','threadCpuMs'])),blocks:r.details.blocks.map((b:any)=>nums(b,['sequence','wallMs','decodeCalls','rawHits']))};
  }
  const conversion=nums(r.conversion,['outputRate','firTaps','filterDelayMs','outputRms','outputPeak','outputClipped','appendedSamples']);
  if(conversion.outputRate!==16000 || conversion.appendedSamples!==0 || buffer.queuedCapacity!==4 || buffer.decoderBlocks!==1 || buffer.assemblerBlocks!==1
    || capture.requestedSeconds!==seconds || Number(buffer.highWater)>4)reject();
  if(r.state==='COMPLETED'){
    if(r.code!=='CAPTURE_COMPLETED'||!Number.isInteger(format.channels)||!Number.isInteger(format.rate)||channels.some((c:any)=>c.samples!==capture.framesReceived))reject();
    if(['decodeCalls','firstDecodeWallMs','medianDecodeWallMs','p95DecodeWallMs','maxDecodeWallMs','maxBlockWallMs','processingWallMs','rtf'].some(key=>inference[key]===null)
      || !preparation.newStream || (mode==='WARM' && Number(preparation.decodeCalls)<2)
      || Object.values(cleanup).some(v=>v===false) || capture.overflows!==0 || capture.discontinuities!==0 || capture.sequenceErrors!==0
      || capture.unconvertedFrames!==0 || capture.unprocessedSamples!==0 || buffer.pendingAfterCleanup!==0 || buffer.abandonedBlocksOnFailure!==0
      || capture.framesConverted!==capture.framesReceived || !format.rate
      || capture.resampledSamples!==Math.floor(Number(capture.framesReceived)*16000/format.rate)
      || capture.processedSamples!==capture.resampledSamples || capture.processedBlocks!==Math.ceil(Number(capture.processedSamples)/1600)
      || Number(recognition.rawHits)!==Number(recognition.detections)+Number(recognition.suppressedHits)
      || (source==='MICROPHONE' && Number(capture.wallMs)<seconds*1000))reject();
  }
  if(source==='REPLAY' && (r.wavSha256!==expected.wavSha256 || r.pcmSha256!==expected.pcmSha256))reject();
  if(source==='MICROPHONE' && (r.wavSha256!==null || r.pcmSha256!==null || r.processedPcmSha256!==null))reject();
  if(source==='REPLAY' && r.processedPcmSha256!==null && !/^[a-f0-9]{64}$/.test(r.processedPcmSha256??''))reject();
  if(source==='REPLAY' && r.state==='COMPLETED' && r.processedPcmSha256!==expected.pcmSha256)reject();
  const technicalThresholdsMet=r.state==='COMPLETED' && source==='MICROPHONE' && seconds>=60 && Number(inference.decodeCalls)>0
    && inference.firstDecodeWallMs!==null && Number(inference.firstDecodeWallMs)<200 && Number(inference.maxBlockWallMs)<200 && inference.rtf!==null && Number(inference.rtf)<.7;
  const fnDiagnostics=validateFnDiagnostics(r.fnDiagnostics,{state:r.state,capture,inference,positions},diagnostic?.trialId,diagnostic?.host??r.fnDiagnostics?.hostMarkers??[]);
  return {schema:1,backend:'NATIVE_LIVE',state:r.state,code:codes.has(r.code)?r.code:'NATIVE_LIVE_FAILED',source,mode,configuration:effectiveConfiguration,thresholdEvidence,
    runtime:{version:'2.0.0',dllHashes:sdkHashes},modelHashes:expected.modelHashes,keywordSha256:expected.keywordSha256,
    wavSha256:source==='REPLAY'?r.wavSha256:null,pcmSha256:source==='REPLAY'?r.pcmSha256:null,processedPcmSha256:source==='REPLAY'?r.processedPcmSha256:null,format:{...format,kind:r.format.kind},conversion,
    capture,buffer,preparation,inference,recognition,channels,memory:{...memory,residentWindows10s},cleanup,positions,details,
    ...(fnDiagnostics?{fnDiagnostics}:{}),technicalThresholdsMet,acceptance:'MANUAL_REVIEW_REQUIRED',cpuScope:'CALLING_INFERENCE_THREAD_NOT_PROCESS',
    latencyScope:'LAST_INPUT_SAMPLE_OF_DETECTION_BLOCK_NOT_ACOUSTIC_LATENCY'};
}

export async function livePreflight(executable:string,lockPath:string,replay?:string,threshold=.25){
  liveConfiguration(threshold);if(replay && threshold!==.25)throw new SpikeError('REPLAY_THRESHOLD_UNSUPPORTED');
  const exe=await localPath(executable),lock=JSON.parse(await readFile(await localPath(lockPath),'utf8'));
  if(lock.schema!==1||lock.kind!=='NATIVE_LIVE'||lock.version!=='2.0.0'||lock.commit!==runtimeCommit||lock.artifactSha256!==artifactSha256
    || lock.executableSha256!==sha(await readFile(exe)))throw new SpikeError('NATIVE_LOCK_MISMATCH');
  for(const [name,key] of [['native-live.cc','sourceSha256'],['reference-kws.cc','referenceSourceSha256'],['native-live-core.h','coreSourceSha256'],['native-fn-core.h','diagnosticSourceSha256'],['native-calibration-core.h','calibrationSourceSha256']])
    if(lock[key!]!==sha(await readFile(new URL(name!,import.meta.url))))throw new SpikeError('NATIVE_LOCK_MISMATCH');
  for(const [name,hash] of Object.entries(sdkHashes))if(sha(await readFile(await localPath(resolve(dirname(exe),name))))!==hash)throw new SpikeError('SDK_HASH_MISMATCH');
  const {loadAssets,defaultRoot}=await import(new URL('./server.mjs',import.meta.url).href);
  const assets=await loadAssets().catch(()=>{throw new SpikeError('MODEL_ASSETS_UNAVAILABLE');});
  if(JSON.stringify(assets.manifest.keywords)!==JSON.stringify([['▁a','t','la','s']]))throw new SpikeError('KEYWORDS_INVALID');
  const modelHashes=Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(name=>[name,sha(assets.files.get('/assets/model/'+name))]));
  const keyword=liveKeyword(threshold);
  const expected:any={modelHashes,keywordSha256:sha(keyword)};
  let wav:string|undefined;
  if(replay){const data=await input(replay);data.pcm.fill(0);wav=data.wavPath;expected.wavSha256=data.wavSha256;expected.pcmSha256=data.pcmSha256;}
  return {exe,keyword,root:defaultRoot,expected,wav};
}

// Abort requests cooperative Stop first. The watchdog may terminate only this owned
// experimental child if a synchronous DLL call never returns; never claim clean release then.
export function runLiveChild(exe:string,args:string[],seconds:number,signal:AbortSignal,progress:(stage:string)=>void=()=>{},
  launch:(file:string,args:string[])=>ChildProcess=(file,args)=>spawn(file,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']}), watchdogMs=(seconds+60)*1000, markers?:NativeMarkers, observeResult?:(result:{report:any;exitCode:number|null})=>void) {
  return new Promise<{report:any;exitCode:number|null}>((resolveResult,rejectResult)=>{
    let child:ChildProcess;
    try{child=launch(exe,args);}catch{rejectResult(new SpikeError('NATIVE_LIVE_CHILD_FAILED'));return;}
    let stdout='',stderr='',failure:string|undefined,killTimer:ReturnType<typeof setTimeout>|undefined,stopSent=false,closed=false;
    const stop=()=>{if(!stopSent){stopSent=true;try{child.stdin?.write('S');}catch{failure??='NATIVE_LIVE_CHILD_FAILED';}}
      killTimer??=setTimeout(()=>{failure??='NATIVE_LIVE_STOP_TIMEOUT';child.kill();},5000);};
    const timer=setTimeout(()=>{failure='NATIVE_LIVE_TIMEOUT';stop();},watchdogMs);
    const abort=()=>stop();signal.addEventListener('abort',abort,{once:true});
    markers?.attach(value=>{if(!closed&&!stopSent)child.stdin?.write(value);});
    child.stdin?.on('error',()=>{});
    child.stdout?.on('data',(chunk:Buffer)=>{if(closed)return;if(stdout.length+chunk.length>4*1024*1024){failure='NATIVE_LIVE_OUTPUT_LIMIT';stop();}else stdout+=chunk.toString('utf8');});
    child.stderr?.on('data',(chunk:Buffer)=>{if(closed)return;stderr=(stderr+chunk.toString('utf8')).slice(-1024);let at:number;
      while((at=stderr.indexOf('\n'))>=0){const stage=stderr.slice(0,at).trim();stderr=stderr.slice(at+1);
        try{if(markers&&stage.startsWith('ACK ')){const ack=markers.ack(stage);progress(`MARKER_ACK ${ack.id} ${ack.kind} ${ack.alignmentUsable?'ALIGNED':'AMBIGUOUS'}`);}
          else if(stages.has(stage)){markers?.stage(stage);progress(stage);}}
        catch{failure='NATIVE_LIVE_PROGRESS_FAILED';stop();}}});
    child.on('error',()=>{failure='NATIVE_LIVE_CHILD_FAILED';});
    child.once('close',(code:number|null)=>{closed=true;markers?.close();
      clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',abort);child.stdin?.destroy();
      if(failure){
        if(observeResult){let report:any=null;try{report=JSON.parse(stdout);}catch{}try{observeResult({report,exitCode:code});}catch{/* Preserve the existing supervisor failure. */}}
        rejectResult(new SpikeError(failure));return;
      }
      try{let report:any;try{report=JSON.parse(stdout);}catch{observeResult?.({report:null,exitCode:code});throw new SpikeError('NATIVE_LIVE_CHILD_FAILED');}
        observeResult?.({report,exitCode:code});if(![0,2,130].includes(code??-1) || (code===0 && report.state!=='COMPLETED') || (code===130 && report.state!=='CANCELLED'))reject();resolveResult({report,exitCode:code});}
      catch{rejectResult(new SpikeError('NATIVE_LIVE_CHILD_FAILED'));}
    });
    if(signal.aborted)stop();
  });
}

export function compareReplay(live:any,wasm:any){
  try{wasm=validateTrial(wasm,{wavSha256:live.wavSha256,modelHashes:live.modelHashes,keywordSha256:live.keywordSha256},'WASM',live.mode);}
  catch{throw new SpikeError('REPLAY_EQUIVALENCE_FAILED');}
  if(live.state!=='COMPLETED'||live.source!=='REPLAY'||live.capture.processedSamples!==330411||live.capture.processedBlocks!==207
    ||live.recognition.rawHits!==3||live.recognition.detections!==3||live.recognition.suppressedHits!==0
    ||live.processedPcmSha256!==wasm.pcmSha256||live.inference.decodeCalls!==64||wasm.decodes?.length!==64||live.wavSha256!==wasm.wavSha256||live.pcmSha256!==wasm.pcmSha256
    ||!same(live.modelHashes,wasm.modelHashes)||live.keywordSha256!==wasm.keywordSha256||!same(live.configuration,wasm.configuration)
    ||JSON.stringify(live.positions.map((p:any)=>p.block))!==JSON.stringify([27,46,91])
    ||JSON.stringify(live.positions.map((p:any)=>({block:p.block,startTimeSec:p.startTimeSec,timestampsSec:p.timestampsSec})))!==JSON.stringify(wasm.hitPositions)
    ||JSON.stringify(live.details?.decodes.map((d:any)=>d.block))!==JSON.stringify(wasm.decodes.map((d:any)=>d.block)))throw new SpikeError('REPLAY_EQUIVALENCE_FAILED');
  return {state:'EQUIVALENT_ON_AUTHORIZED_PCM_ONLY',liveStabilityApproved:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let lines:ReturnType<typeof createInterface>|undefined;
  const controller=new AbortController(),stop=()=>controller.abort();
  try{
    const [exe,lock,mode,duration,...flags]=process.argv.slice(2),seconds=Number(duration);
    if(process.platform!=='win32'||process.arch!=='x64'||!exe||!lock||!['COLD','WARM'].includes(mode??'')||!Number.isInteger(seconds)||seconds<1||(seconds>120&&seconds!==180))throw Error();
    const {check,detail,replay,threshold,thresholdSpecified,diagnosticWindows=false}=parseLiveFlags(flags);
    // 180 s here is a read-only preflight only; capture requires calibration consent.
    if(seconds===180&&(!check||mode!=='COLD'||threshold!==.15||replay||diagnosticWindows))throw new SpikeError('ARGUMENT_INVALID');
    if(diagnosticWindows&&(mode!=='COLD'||threshold!==.15||seconds!==60||replay))throw new SpikeError('ARGUMENT_INVALID');
    const ready=await livePreflight(exe,lock,replay,threshold);
    if(check)console.log(JSON.stringify({state:'PREFLIGHT_OK',mode,seconds,source:replay?'REPLAY':'MICROPHONE',configuration:liveConfiguration(threshold),...ready.expected}));
    else{
      const markers=diagnosticWindows?new NativeMarkers(randomBytes(16).toString('hex')):undefined;
      process.on('SIGINT',stop);lines=createInterface({input:process.stdin});lines.on('line',line=>{
        if(markers&&(line==='b'||line==='e')){try{if(!markers.mark(line==='b'?'B':'E'))console.error('MARKER_NOT_READY');}
          catch{console.error('MARKER_INPUT_FAILED');stop();}}
        else stop();
      });
      console.error('INITIALIZING — Enter o Ctrl+C solicita Stop; esperar CAPTURE_STARTED o REPLAY_STARTED.');
      const args=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(name=>resolve(ready.root,'model',name));
      const result=await runLiveChild(ready.exe,[...args,ready.keyword,mode!,String(seconds),...(markers?['--diagnostic-windows',markers.trialId]:[]),...(thresholdSpecified?['--threshold',String(threshold)]:[]),...(detail||replay||markers?['--detail']:[]),...(ready.wav?['--replay',ready.wav]:[])],seconds,controller.signal,stage=>console.error(stage),undefined,undefined,markers);
      const report=cleanLiveReport(result.report,ready.expected,mode as 'COLD'|'WARM',replay?'REPLAY':'MICROPHONE',seconds,threshold,markers?{trialId:markers.trialId,host:markers.snapshot()}:undefined);
      let equivalence:any=null;
      if(replay && report.state==='COMPLETED'){
        // Separate process: the WASM adapter can wipe its entire own heap safely.
        const wasm=await runLiveChild(process.execPath,['--import','tsx',fileURLToPath(new URL('./benchmark-wasm.ts',import.meta.url)),ready.wav!,mode!],seconds,controller.signal);
        equivalence=compareReplay(report,wasm.report);
      }
      console.log(JSON.stringify({...report,equivalence}));process.exitCode=result.exitCode??2;
    }
  }catch(error){const allowed=['NATIVE_LIVE_PROGRESS_FAILED','FN_DIAGNOSTICS_INVALID','THRESHOLD_INVALID','ARGUMENT_INVALID','REPLAY_THRESHOLD_UNSUPPORTED','MODEL_ASSETS_UNAVAILABLE','NATIVE_LOCK_MISMATCH','SDK_HASH_MISMATCH','KEYWORDS_INVALID','NATIVE_LIVE_REPORT_INVALID','REPLAY_EQUIVALENCE_FAILED','NATIVE_LIVE_TIMEOUT','NATIVE_LIVE_STOP_TIMEOUT','NATIVE_LIVE_OUTPUT_LIMIT','NATIVE_LIVE_CHILD_FAILED'];
    console.log(JSON.stringify({state:'FAILED',code:error instanceof SpikeError && allowed.includes(error.code)?error.code:'NATIVE_LIVE_PREFLIGHT_FAILED',acceptance:'NOT_ESTABLISHED'}));process.exitCode=2;
  }finally{process.removeListener('SIGINT',stop);lines?.close();}
}
