import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configuration, distribution, expectedPcm, sdkHashes, sha, summarize, validateTrial } from '../../experiments/wake-word/benchmark-contract.js';
import { series } from '../../experiments/wake-word/native-benchmark.js';
import { wasmTrial } from '../../experiments/wake-word/benchmark-wasm.js';
import { canonicalBytes } from '../../experiments/wake-word/trace.js';

const expected={wavSha256:sha('authorized-wave'),keywordSha256:sha('keyword'),modelHashes:{'encoder.onnx':sha('encoder'),'decoder.onnx':sha('decoder'),'joiner.onnx':sha('joiner'),'tokens.txt':sha('tokens')}};
function trial(backend='WASM',mode='WARM'):any {
  const blocks=[4,8,12,27,46,91];
  return {schema:1,state:'COMPLETED',backend,mode,configuration:{...configuration},...structuredClone(expected),pcmSha256:expectedPcm,
    runtime:backend==='NATIVE'?{version:'2.0.0',git:'8abb7c8f',dlls:Object.entries(sdkHashes).slice(0,2).map(([name,sha256])=>({name,sha256}))}:{version:'@sherpaw/kws 0.3.0'},
    processedSamples:330411,blocks:207,rawHits:3,detections:3,suppressedHits:0,appendedSilenceSamples:0,
    events:[27,46,91].map(block=>({block,sampleOffset:block*1600,sampleEnd:(block+1)*1600,rawHits:1})),
    hitPositions:[27,46,91].map(block=>({block,startTimeSec:0,timestampsSec:[block/10]})),
    moduleLoadWallMs:5,initializationWallMs:12,preparation:{newStream:true,syntheticBlocks:mode==='WARM'?9:0,decodeCalls:mode==='WARM'?2:0,wallMs:90,resetWallMs:1},
    processing:{wallMs:400,threadCpuMs:150,rtf:400/(330411/16),maxBlockWallMs:20},
    decodes:blocks.map(block=>({block,wallMs:10,threadCpuMs:5})),
    blockMetrics:Array.from({length:207},(_,sequence)=>({sequence,wallMs:sequence===4?20:1,threadCpuMs:.5,decodeCalls:Number(blocks.includes(sequence)),rawHits:Number([27,46,91].includes(sequence))})),
    memory:{residentStartBytes:100,residentEndBytes:110,residentPeakBytes:120,peakKind:backend==='NATIVE'?'OS_PEAK':'SAMPLED_PROCESS_RSS',wasmHeapBytes:backend==='WASM'?512*1024*1024:null},cleanupCompleted:true};
}
test('benchmark preserves hashes, configuration, timing positions and sample counts while removing untrusted output',()=>{
  const r=trial();r.privatePath='PRIVATE_DEVICE';r.runtime.arguments='SECRET';r.decodes[0].pcm='SECRET_PCM';r.hitPositions[0].transcription='SECRET_TEXT';
  const clean=validateTrial(r,expected,'WASM','WARM');
  assert.equal(clean.pcmSha256,expectedPcm);assert.deepEqual(clean.hitPositions,trial().hitPositions);
  assert.doesNotMatch(JSON.stringify(clean),/SECRET|PRIVATE_DEVICE/);
});
test('benchmark rejects acoustic, hash, configuration, reset and cleanup discrepancies',()=>{
  const mutations=[(r:any)=>r.wavSha256=sha('other'),(r:any)=>r.pcmSha256=sha('other'),(r:any)=>r.modelHashes['encoder.onnx']=sha('other'),
    (r:any)=>r.configuration.threshold=.05,(r:any)=>r.processedSamples--,(r:any)=>r.blocks--,(r:any)=>r.rawHits=2,
    (r:any)=>r.events[0].block=28,(r:any)=>r.hitPositions[0].timestampsSec=[NaN],(r:any)=>r.suppressedHits=1,
    (r:any)=>r.appendedSilenceSamples=1,(r:any)=>r.preparation.newStream=false,(r:any)=>r.preparation.decodeCalls=1,
    (r:any)=>r.cleanupCompleted=false,(r:any)=>r.processing.threadCpuMs=-1,(r:any)=>r.blockMetrics[0].decodeCalls=1];
  for(const mutate of mutations){const r=trial();mutate(r);assert.throws(()=>validateTrial(r,expected,'WASM','WARM'),/BENCHMARK_EQUIVALENCE_FAILED/);}
});
test('native runtime identity and DLL hashes must match the audited SDK',()=>{
  assert.equal(validateTrial(trial('NATIVE'),expected,'NATIVE','WARM').runtime.version,'2.0.0');
  for(const change of [(r:any)=>r.runtime.version='1.0.0',(r:any)=>r.runtime.dlls[0].sha256=sha('tampered'),(r:any)=>r.runtime.git+=' private']){
    const r=trial('NATIVE');change(r);assert.throws(()=>validateTrial(r,expected,'NATIVE','WARM'));
  }
});
test('20 independent trials per backend are awaited sequentially, with balanced order and separate modes',async()=>{
  for(const mode of ['COLD','WARM'] as const){let active=0,calls=0;const seen=new Set(),order:string[]=[];
    const r=await series(expected,mode,async(backend,m,i)=>{assert.equal(active++,0);calls++;order.push(backend);assert.equal(m,mode);
      const key=backend+i;assert.ok(!seen.has(key));seen.add(key);await Promise.resolve();active--;
      return {value:trial(backend,m),processWallMs:500};});
    assert.equal(r.state,'COMPLETED');assert.equal(calls,40);assert.equal(active,0);
    assert.deepEqual(order.slice(0,4),['WASM','NATIVE','NATIVE','WASM']);
  }
});
test('runtime failure stops without retries or leaking raw exception data',async()=>{
  let calls=0;const r=await series(expected,'WARM',async()=>{calls++;throw Error('PRIVATE_PATH PCM secret');});
  assert.equal(calls,1);assert.equal(r.state,'FAILED');assert.equal(r.equivalence,'NOT_ESTABLISHED');
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_PATH|PCM|secret/);
});
test('differences in decoder schedule or precise hit positions stop comparison before further trials',async()=>{
  for(const position of [false,true]){let calls=0;
    const r=await series(expected,'WARM',async(backend)=>{calls++;const v=trial(backend);
      if(calls===2){if(position)v.hitPositions[0].timestampsSec[0]+=.01;
        else {v.decodes[0].block=5;v.blockMetrics[4].decodeCalls=0;v.blockMetrics[5].decodeCalls=1;}}
      return {value:v,processWallMs:500};});
    assert.equal(calls,2);assert.equal(r.state,'FAILED');assert.equal(r.code,position?'HIT_POSITION_MISMATCH':'DECODE_SCHEDULE_MISMATCH');
  }
});
test('medians, nearest-rank p95 and maxima expose outliers, missing thread CPU stays null',()=>{
  assert.deepEqual(distribution(Array.from({length:20},(_,i)=>i+1)),{n:20,median:10.5,p95:19,max:20});
  assert.throws(()=>distribution([NaN]));const a=trial(),b=trial();b.processing.threadCpuMs=null;b.decodes[0].threadCpuMs=null;
  const s=summarize([a,b]);assert.equal(s.processingThreadCpuMs,null);assert.equal(s.firstDecodeThreadCpuMs,null);assert.equal(s.cpuCoverage,1);
  assert.equal(s.residentPeakBytes?.max,120);assert.deepEqual(s.memoryPeakKind,['SAMPLED_PROCESS_RSS']);
});
test('WASM measurement preserves PCM, hit blocks, reset isolation and restores adapters on success and inference error',async()=>{
  const originalFetch=globalThis.fetch;
  for(const fail of [false,true]){
    const pcm=new Float32Array(330411).fill(.01),hash=sha(canonicalBytes(pcm));
    let disposed=0,sequence=0,handle=1,decoded=0,writes=0;
    const module:any={HEAPU8:new Uint8Array(64),FS:{writeFile(name:string){assert.match(name,/^\/(encoder.onnx|decoder.onnx|joiner.onnx|tokens.txt)$/);writes++;}},
      _SherpaOnnxCreateKeywordStream(){return ++handle;},_SherpaOnnxDestroyOnlineStream(){},
      _SherpaOnnxOnlineStreamAcceptWaveform(){},_SherpaOnnxIsKeywordStreamReady(){return true;},
      _SherpaOnnxDecodeKeywordStream(){decoded++;if(fail)throw Error('PRIVATE_NATIVE_ERROR');},
      _SherpaOnnxGetKeywordResult(){},_SherpaOnnxDestroyKeywordResult(){},_SherpaOnnxResetKeywordStream(){}};
    const originals=Object.fromEntries(Object.entries(module).filter(([,v])=>typeof v==='function'));
    const engine={reset(){const old=handle;module._SherpaOnnxCreateKeywordStream();module._SherpaOnnxDestroyOnlineStream(old);},
      processAudio(block:Float32Array){assert.equal(block.length,sequence===206?811:1600);assert.equal(block[0],pcm[0]);
        assert.throws(()=>globalThis.fetch('https://invalid.example'),/NETWORK_DISABLED/);
        module._SherpaOnnxOnlineStreamAcceptWaveform();module._SherpaOnnxIsKeywordStreamReady();module._SherpaOnnxDecodeKeywordStream();
        const blockIndex=sequence++;return [27,46,91].includes(blockIndex)?[{label:'Atlas',startTime:0,timestamps:[blockIndex/10]}]:[];},dispose(){disposed++;}};
    const adapters:any={input:async()=>({pcm,pcmSha256:hash,modelHashes:expected.modelHashes,keywordSha256:expected.keywordSha256,wavSha256:expected.wavSha256,
      root:'LOCAL_ONLY',assets:{manifest:{keywords:[['▁a','t','la','s']]},files:new Map()}}),
      runtime:async()=>({initKWSModule:async()=>module,createKeywordSpotter:()=>engine})};
    if(fail)await assert.rejects(wasmTrial('ignored',false,adapters),/ENGINE_FAILED/);
    else {const r=await wasmTrial('ignored',false,adapters);assert.equal(r.processedSamples,330411);assert.equal(r.pcmSha256,hash);
      assert.equal(r.rawHits,3);assert.deepEqual(r.events.map((e:any)=>e.block),[27,46,91]);assert.equal(r.decodes.length,207);assert.equal(decoded,207);}
    assert.equal(disposed,1);assert.equal(writes,4);assert.ok(pcm.every(v=>v===0));assert.ok(module.HEAPU8.every((v:number)=>v===0));
    for(const [key,value] of Object.entries(originals))assert.equal(module[key],value);
    assert.equal(globalThis.fetch,originalFetch);
  }
});
test('benchmark has no production integration, audio writes, padding or completion signals',async()=>{
  const base=new URL('../../experiments/wake-word/',import.meta.url);
  const cpp=await readFile(new URL('reference-kws.cc',base),'utf8'),wasm=await readFile(new URL('benchmark-wasm.ts',base),'utf8');
  assert.doesNotMatch(cpp,/SherpaOnnxOnlineStreamInputFinished\s*\(/);
  assert.match(cpp,/GetThreadTimes\(GetCurrentThread/);assert.match(cpp,/QueryPerformanceCounter/);
  assert.match(cpp,/SherpaOnnxDestroyOnlineStream\(stream\); stream=nullptr; spotter.reset\(\); wave.reset\(\)/);
  assert.match(wasm,/verifyNewStream/);assert.match(wasm,/NETWORK_DISABLED/);assert.match(wasm,/data.pcm.fill\(0\)/);
  for(const text of [cpp,wasm])assert.doesNotMatch(text,/getUserMedia|OpenAIVoiceProvider|DesktopLifecycleRuntime|writeFile[^\n]*pcm/i);
  const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.build.files.every((s:string)=>!s.startsWith('experiments/')));
});
