import { configuration } from './benchmark-contract.js';
import { SpikeError } from './core.js';

export const sensitivityThresholds = [.25,.15,.10,.05] as const;
export function checkedThreshold(value: number): number {
  if(typeof value!=='number' || !sensitivityThresholds.some(t=>t===value))throw new SpikeError('THRESHOLD_INVALID');
  return value;
}
export function parseThreshold(text: string): number {
  if(!['0.25','0.15','0.10','0.1','0.05'].includes(text))throw new SpikeError('THRESHOLD_INVALID');
  return checkedThreshold(Number(text));
}
export const liveConfiguration=(threshold=.25)=>({...configuration,threshold:checkedThreshold(threshold)});
export const liveKeyword=(threshold=.25)=>`▁a t la s :1 #${checkedThreshold(threshold)} @sherpaw_0`;
export function parseLiveFlags(flags:string[]){
  let check=false,detail=false,replay:string|undefined,threshold=.25,thresholdSpecified=false;
  for(let i=0;i<flags.length;i++){
    if(flags[i]==='--check'&&!check)check=true;
    else if(flags[i]==='--detail'&&!detail)detail=true;
    else if(flags[i]==='--replay'&&!replay&&flags[i+1]&&!flags[i+1]!.startsWith('--'))replay=flags[++i];
    else if(flags[i]==='--threshold'&&!thresholdSpecified&&flags[i+1]){threshold=parseThreshold(flags[++i]!);thresholdSpecified=true;}
    else throw new SpikeError('ARGUMENT_INVALID');
  }
  // The published WASM/Offline equivalence contract stays pinned to .25.
  if(replay && threshold!==.25)throw new SpikeError('REPLAY_THRESHOLD_UNSUPPORTED');
  return {check,detail,replay,threshold,thresholdSpecified};
}
