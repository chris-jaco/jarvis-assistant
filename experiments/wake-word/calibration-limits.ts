// Experimental storage/diagnostic bounds, independent of audio transport.
import { SpikeError } from './core.js';
export const shortCalibrationSamples=64*16000;
export const maxCalibrationSamples=124*16000; // Published 120 s contract, unchanged.
export const longCalibrationSamples=184*16000;
export function calibrationMaxSamples(seconds:number){
  if(seconds===60)return shortCalibrationSamples;
  if(seconds===120)return maxCalibrationSamples;
  if(seconds===180)return longCalibrationSamples;
  throw new SpikeError('CAL_DURATION_INVALID');
}
// Legacy diagnostic contracts retain their existing 1300-record ceiling.
export const calibrationBlockLimit=(seconds:unknown)=>seconds===180?1840:1300;
