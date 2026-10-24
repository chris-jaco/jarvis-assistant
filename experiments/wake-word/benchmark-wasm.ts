import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { configuration, input, sha } from './benchmark-contract.js';
import { canonicalBytes } from './trace.js';
import { PcmDetector } from './core.js';
import { createWasmProfiler } from './profile.js';
import { prepareLiveWarm, verifyNewStream } from './live-warmup.js';

function cpu() {
  try { const fn = (process as any).threadCpuUsage; if (typeof fn !== 'function') return null;
    const r = fn(); return (r.user + r.system) / 1000; } catch { return null; }
}
const delta = (start: number | null) => { const end=cpu(); return start===null || end===null || end<start ? null : end-start; };
// Adapters are injectable only for deterministic tests; CLI always uses verified local assets.
export async function wasmTrial(path: string, warm: boolean, adapters = { input, runtime: async(root:string)=>import(pathToFileURL(resolve(root,'runtime/core.js')).href) }) {
  const data = await adapters.input(path); let module: any, engine: any, profiler: any, originalDecode: any;
  const keys=['fetch','XMLHttpRequest','WebSocket','EventSource','WebTransport'];
  const descriptors=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const release=()=>{const owned=engine;engine=undefined;owned?.dispose();};
  try {
    const moduleStart=performance.now();
    const api = await adapters.runtime(data.root);
    module=await api.initKWSModule();
    for (const name of Object.keys(data.modelHashes)) module.FS.writeFile('/'+name,data.assets.files.get('/assets/model/'+name));
    const moduleLoadWallMs=performance.now()-moduleStart;
    for (const key of keys) Object.defineProperty(globalThis,key,{configurable:true,value:()=>{throw Error('NETWORK_DISABLED');}});
    const init=performance.now();
    engine=api.createKeywordSpotter(module,{model:{encoder:'/encoder.onnx',decoder:'/decoder.onnx',joiner:'/joiner.onnx',tokens:'/tokens.txt'},maxActivePaths:4,
      keywords:[{label:'Atlas',matches:data.assets.manifest.keywords.map((tokens: string[])=>({tokens})),score:1,threshold:.25}]});
    const initializationWallMs=performance.now()-init;
    let preparation: any;
    if (warm) { const r=prepareLiveWarm(module,engine); preparation={syntheticBlocks:r.syntheticBlocks,decodeCalls:r.decodeCalls,wallMs:r.wallMs,resetWallMs:r.resetWallMs,newStream:true}; }
    else { const start=performance.now();verifyNewStream(module,()=>engine.reset());const ms=performance.now()-start;preparation={syntheticBlocks:0,decodeCalls:0,wallMs:ms,resetWallMs:ms,newStream:true}; }
    let sequence=0;const decodes: any[]=[],blockMetrics: any[]=[],events: any[]=[],hitPositions: any[]=[];
    let rawHits=0,detections=0,suppressedHits=0,maxBlockWallMs=0;
    let sampledPeak=process.memoryUsage().rss;
    const decode=module._SherpaOnnxDecodeKeywordStream;originalDecode=decode;
    module._SherpaOnnxDecodeKeywordStream=function(...args: any[]) {
      const start=performance.now(), used=cpu();
      try {return Reflect.apply(decode,this,args);} finally {
        if (decodes.length>=10000) throw Error('DECODE_LIMIT');
        decodes.push({block:sequence,wallMs:performance.now()-start,threadCpuMs:delta(used)});
      }
    };
    profiler=createWasmProfiler(module,undefined,undefined,3000);
    const profiled=profiler.wrapEngine(engine),detector=new PcmDetector({
      processAudio(pcm,rate){const hits=profiled.processAudio(pcm,rate) as any[];
        for(const hit of hits)if(hit.label==='Atlas')hitPositions.push({block:sequence,startTimeSec:hit.startTime,timestampsSec:hit.timestamps});
        return hits;},dispose:()=>profiled.dispose()},()=>sequence*100);
    const residentStartBytes=process.memoryUsage().rss, start=performance.now(),used=cpu();
    try {
      for(let at=0;at<data.pcm.length;at+=1600) {
        const block=data.pcm.slice(at,at+1600), prior=decodes.length, begin=performance.now(),c=cpu();
        const r=detector.process(block,16000),wallMs=performance.now()-begin,threadCpuMs=delta(c);
        rawHits+=r.rawHits;detections+=Number(r.detected);suppressedHits+=r.suppressedHits;
        if(r.rawHits)events.push({block:sequence,sampleOffset:at,sampleEnd:at+block.length,rawHits:r.rawHits});
        blockMetrics.push({sequence,wallMs,threadCpuMs,decodeCalls:decodes.length-prior,rawHits:r.rawHits});
        maxBlockWallMs=Math.max(maxBlockWallMs,wallMs);sampledPeak=Math.max(sampledPeak,process.memoryUsage().rss);sequence++;
      }
      const wallMs=performance.now()-start,threadCpuMs=delta(used),residentEndBytes=process.memoryUsage().rss,wasmHeapBytes=module.HEAPU8.byteLength;
      const canonical=canonicalBytes(data.pcm),unchanged=sha(canonical)===data.pcmSha256;canonical.fill(0);
      if(!unchanged)throw Error('PCM_MUTATED');
      const report={schema:1,state:'COMPLETED',backend:'WASM',mode:warm?'WARM':'COLD',runtime:{version:'@sherpaw/kws 0.3.0'},configuration,
        modelHashes:data.modelHashes,keywordSha256:data.keywordSha256,wavSha256:data.wavSha256,pcmSha256:data.pcmSha256,
        processedSamples:data.pcm.length,blocks:sequence,rawHits,detections,suppressedHits,appendedSilenceSamples:0,events,hitPositions,
        initializationWallMs,moduleLoadWallMs,preparation,processing:{wallMs,threadCpuMs,rtf:wallMs/(data.pcm.length/16),maxBlockWallMs},decodes,blockMetrics,
        memory:{residentStartBytes,residentEndBytes,residentPeakBytes:Math.max(sampledPeak,residentEndBytes),peakKind:'SAMPLED_PROCESS_RSS',wasmHeapBytes},cleanupCompleted:true};
      engine=undefined;detector.stop();return report;
    } finally {profiler.restore();module._SherpaOnnxDecodeKeywordStream=decode;}
  } finally {try{profiler?.restore();if(originalDecode)module._SherpaOnnxDecodeKeywordStream=originalDecode;release();}finally{data.pcm.fill(0);module?.HEAPU8.fill(0);
    keys.forEach((key,i)=>{const d=descriptors[i];if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);});}}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const print=console.log.bind(console);for(const k of ['log','info','warn','error','debug'] as const)console[k]=()=>{};
  try {if(process.argv.length!==4 || !['COLD','WARM'].includes(process.argv[3]!))throw Error();
    print(JSON.stringify(await wasmTrial(process.argv[2]!,process.argv[3]==='WARM')));
  }catch{print(JSON.stringify({state:'FAILED',code:'WASM_TRIAL_FAILED'}));process.exitCode=2;}
}
