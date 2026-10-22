import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
export function keywordText(keywords, threshold) {
  return keywords.map(tokens => `${tokens.join(' ')} :1 #${threshold} @sherpaw_0`).join('\n');
}
export async function runReference(executable, wavPath, root, keywords, threshold, expectedSamples) {
  try {
    const args = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map(n => resolve(root, 'model', n));
    const { stdout } = await promisify(execFile)(executable, [...args, keywordText(keywords, threshold), wavPath, String(threshold)],
      { timeout: 120000, maxBuffer: 65536, windowsHide: true });
    const r = JSON.parse(stdout);
    if (!Number.isSafeInteger(r.rawHits) || r.rawHits < 0 || r.rawHits > 1000
      || r.processedSamples !== expectedSamples || r.blocks !== Math.ceil(expectedSamples / 1600) || r.appendedSilenceSamples !== 0) throw Error();
    return { state: 'COMPLETED', rawHits: r.rawHits, processedSamples: r.processedSamples, blocks: r.blocks, appendedSilenceSamples: 0 };
  } catch { return { state: 'REFERENCE_FAILED' }; }
}
