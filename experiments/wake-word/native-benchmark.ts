// Opt-in offline comparison. Never imported by Atlas production.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration, input, localPath, sdkHashes, sha, summarize, validateTrial } from './benchmark-contract.js';
import { SpikeError } from './core.js';

export const artifactSha256 = '98d8cf1c0e0bfb5768042e90ffe9591203855b8f4aabdcd5c154eb39b87a0707';
export const runtimeCommit = '8abb7c8f87eae85b2e75f9a4115236c978980add';
export async function preflight(wav: string, executable: string, lockPath: string) {
  const exe=await localPath(executable), lockFile=await localPath(lockPath);
  const lock=JSON.parse(await readFile(lockFile,'utf8'));
  if (lock.schema!==1 || lock.version!=='2.0.0' || lock.commit!==runtimeCommit || lock.artifactSha256!==artifactSha256
    || lock.sourceSha256!==sha(await readFile(new URL('./reference-kws.cc',import.meta.url)))
    || lock.executableSha256!==sha(await readFile(exe))) throw new SpikeError('NATIVE_LOCK_MISMATCH');
  for(const [name,hash] of Object.entries(sdkHashes)) {
    const file=await localPath(resolve(dirname(exe),name));
    if(sha(await readFile(file))!==hash)throw new SpikeError('SDK_HASH_MISMATCH');
  }
  const data=await input(wav);
  const expected={wavSha256:data.wavSha256,modelHashes:data.modelHashes,keywordSha256:data.keywordSha256};
  data.pcm.fill(0);
  return {expected,exe,wav:data.wavPath,root:data.root,keyword:data.keyword,
    provenance:{sdkVersion:'2.0.0',runtimeCommit,artifactSha256,sourceSha256:lock.sourceSha256,executableSha256:lock.executableSha256,dllHashes:sdkHashes}};
}

// Await execFile's close callback: no retries, overlap or process pooling.
async function child(file: string,args: string[]) {
  const begin=performance.now();
  try {
    const {stdout}=await promisify(execFile)(file,args,{shell:false,windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    return {value:JSON.parse(stdout),processWallMs:performance.now()-begin};
  } catch { throw new SpikeError('BENCHMARK_CHILD_FAILED'); }
}
export type Execute = (backend: 'WASM'|'NATIVE',mode: 'COLD'|'WARM',trial: number)=>Promise<{value:any;processWallMs:number}>;
export async function series(expected: any, mode: 'COLD'|'WARM', execute: Execute) {
  const trials: Record<string,any[]>={WASM:[],NATIVE:[]};
  let schedule: string | undefined, positions: string | undefined;
  try {
    for(let trial=0;trial<20;trial++) {
      const order: Array<'WASM'|'NATIVE'>=trial%2?['NATIVE','WASM']:['WASM','NATIVE'];
      for(const backend of order) {
        const result=await execute(backend,mode,trial);
        const clean=validateTrial(result.value,expected,backend,mode);
        if(!Number.isFinite(result.processWallMs)||result.processWallMs<0)throw new SpikeError('METRICS_INVALID');
        const current=JSON.stringify(clean.decodes.map((d:any)=>d.block)), hitPositions=JSON.stringify(clean.hitPositions);
        if(schedule!==undefined && current!==schedule)throw new SpikeError('DECODE_SCHEDULE_MISMATCH');
        if(positions!==undefined && hitPositions!==positions)throw new SpikeError('HIT_POSITION_MISMATCH');
        schedule=current;positions=hitPositions;
        trials[backend]!.push({...clean,trial,processWallMs:result.processWallMs});
      }
    }
    const {distribution}=await import('./benchmark-contract.js');
    return {state:'COMPLETED',mode,trialsPerBackend:20,equivalence:'AUTHORIZED_WAV_ONLY',
      measurement:{wall:'ELAPSED_NOT_CPU',cpu:'CALLING_THREAD_KERNEL_PLUS_USER_OR_NULL',
        processWall:'CHILD_START_TO_CLOSE_INCLUDES_STARTUP_AND_REPORTING',rtf:'PROCESSING_WALL_DIVIDED_BY_AUDIO_DURATION',
        nativeMemory:'OS_PEAK_WORKING_SET',wasmMemory:'SAMPLED_PROCESS_RSS_NOT_EXACT_PEAK',cpuNotWholeRuntime:true},
      summaries:Object.fromEntries(Object.entries(trials).map(([key,values])=>[key,{...summarize(values),
        processWallMs:distribution(values.map(v=>v.processWallMs))}])),trials};
  } catch(error) {
    const allowed=['BENCHMARK_EQUIVALENCE_FAILED','DECODE_SCHEDULE_MISMATCH','HIT_POSITION_MISMATCH','METRICS_INVALID','BENCHMARK_CHILD_FAILED'];
    return {state:'FAILED',mode,code:error instanceof SpikeError && allowed.includes(error.code)?error.code:'BENCHMARK_FAILED',
      completedTrials:{WASM:trials.WASM!.length,NATIVE:trials.NATIVE!.length},equivalence:'NOT_ESTABLISHED'};
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [wav,exe,lock,operation,mode]=process.argv.slice(2);
    if(process.platform!=='win32' || process.arch!=='x64' || !wav || !exe || !lock
      || !['--check','--run'].includes(operation??'') || !['COLD','WARM'].includes(mode??'') || process.argv.length!==7)throw Error();
    const ready=await preflight(wav,exe,lock);
    if(operation==='--check')console.log(JSON.stringify({state:'PREFLIGHT_OK',configuration,provenance:ready.provenance,...ready.expected}));
    else {
      const run=await series(ready.expected,mode as 'COLD'|'WARM',async(backend,m)=>{
        if(backend==='WASM')return child(process.execPath,['--import','tsx',fileURLToPath(new URL('./benchmark-wasm.ts',import.meta.url)),ready.wav,m]);
        const models=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n=>resolve(ready.root,'model',n));
        return child(ready.exe,[...models,ready.keyword,ready.wav,'0.25',...(m==='WARM'?['--warm']:[])]);
      });
      console.log(JSON.stringify({...run,provenance:ready.provenance,nodeVersion:process.version}));
      if(run.state!=='COMPLETED')process.exitCode=2;
    }
  }catch{console.log(JSON.stringify({state:'FAILED',code:'BENCHMARK_PREFLIGHT_FAILED'}));process.exitCode=2;}
}
