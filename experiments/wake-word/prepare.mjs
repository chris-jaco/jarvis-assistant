// Preparation only: the server and listening harness never import this downloader.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const repo = 'jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08';
export const revisionPrefix = 'b55eae7'; // Resolve to full immutable SHA before any weight download.
export const runtimeVersion = '0.3.0';
const runtimeIntegrity = 'gT9UJs/zf2/TuvDTStka4rGymENqTVkF4a5IKaaHaURax1dmTtBlZDj5CTurnXBCYTSGamlUG9Nc8rr56UX3PQ==';
export const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/wake-word-spike');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Small protobuf reader for structural ONNX validation and SentencePiece ASCII keyword encoding.
export function fields(bytes) {
  const out = []; let p = 0;
  function variable() {
    let v = 0n, shift = 0n;
    do { if (p >= bytes.length || shift > 63n) throw Error('PROTO_INVALID'); const c = bytes[p++]; v |= BigInt(c & 127) << shift; if (!(c & 128)) return v; shift += 7n; } while (true);
  }
  while (p < bytes.length) {
    const tag = Number(variable()), type = tag & 7, id = tag >>> 3;
    if (!id) throw Error('PROTO_INVALID');
    let value;
    if (type === 0) value = variable();
    else if (type === 2) { const n = Number(variable()); if (!Number.isSafeInteger(n) || p + n > bytes.length) throw Error('PROTO_INVALID'); value = bytes.subarray(p, p + n); p += n; }
    else if (type === 5 || type === 1) { const n = type === 5 ? 4 : 8; if (p + n > bytes.length) throw Error('PROTO_INVALID'); value = bytes.subarray(p, p + n); p += n; }
    else throw Error('PROTO_INVALID');
    out.push({ id, type, value });
  }
  return out;
}
export function checkOnnx(bytes) {
  const f = fields(bytes);
  if (!f.some(x => x.id === 1 && x.type === 0 && x.value > 0n)
    || !f.some(x => x.id === 7 && x.type === 2 && x.value.length)) throw Error('ONNX_INVALID');
}
export function keywordTokens(modelBytes, tokenText, word) {
  // Atlas is ASCII: no general-purpose multilingual text-normalizer is claimed here.
  if (!/^[A-Za-z]+$/.test(word)) throw Error('KEYWORD_UNSUPPORTED');
  const parts = fields(modelBytes);
  const vocabulary = new Set(tokenText.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]));
  const pieces = new Map();
  for (const f of parts.filter(x => x.id === 1 && x.type === 2)) {
    const data = fields(f.value);
    const name = data.find(x => x.id === 1 && x.type === 2)?.value;
    const score = data.find(x => x.id === 2 && x.type === 5)?.value;
    const kind = data.find(x => x.id === 3 && x.type === 0)?.value ?? 1n;
    if (name && score && kind === 1n) {
      const token = new TextDecoder().decode(name);
      const n = new DataView(score.buffer, score.byteOffset, 4).getFloat32(0, true);
      if (Number.isFinite(n) && vocabulary.has(token)) pieces.set(token, n);
    }
  }
  const trainer = parts.find(x => x.id === 2 && x.type === 2)?.value;
  const kind = trainer ? fields(trainer).find(x => x.id === 3 && x.type === 0)?.value ?? 1n : 1n;
  const text = `▁${word}`;
  if (kind === 2n) {
    const tokens = [...text];
    while (true) {
      let best = -Infinity, at = -1;
      for (let i = 0; i < tokens.length - 1; i++) {
        const score = pieces.get(tokens[i] + tokens[i + 1]);
        if (score !== undefined && score > best) { best = score; at = i; }
      }
      if (at < 0) break;
      tokens.splice(at, 2, tokens[at] + tokens[at + 1]);
    }
    if (tokens.every(t => vocabulary.has(t))) return tokens;
  } else if (kind === 1n) {
    const paths = new Map([[0, { score: 0, tokens: [] }]]);
    for (let i = 0; i < text.length; i++) {
      const previous = paths.get(i); if (!previous) continue;
      for (const [token, score] of pieces) if (text.startsWith(token, i)) {
        const end = i + token.length, candidate = previous.score + score;
        if (!paths.has(end) || candidate > paths.get(end).score) paths.set(end, { score: candidate, tokens: [...previous.tokens, token] });
      }
    }
    if (paths.has(text.length)) return paths.get(text.length).tokens;
  }
  throw Error('KEYWORD_UNSUPPORTED');
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Error('DOWNLOAD_FAILED');
  return new Uint8Array(await response.arrayBuffer());
}
async function save(name, bytes) {
  const path = resolve(assetRoot, name); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes); return { name, sha256: sha256(bytes), bytes: bytes.length };
}
export async function prepare(runtimeOnly = false) {
  await mkdir(assetRoot, { recursive: true });
  // An interrupted preparation must never leave a previously approved manifest active.
  await rm(resolve(assetRoot, 'manifest.json'), { force: true });
  const archive = await download(`https://registry.npmjs.org/@sherpaw/kws/-/kws-${runtimeVersion}.tgz`);
  if (createHash('sha512').update(archive).digest('base64') !== runtimeIntegrity) throw Error('RUNTIME_INTEGRITY_FAILED');
  const work = resolve(assetRoot, 'preparation'); await mkdir(work, { recursive: true });
  const tarball = resolve(work, 'runtime.tgz'); await writeFile(tarball, archive);
  const runtimeFiles = ['dist/core.js', 'dist/wasm-CP0rq9dg.js', 'dist/prebuilt/kws.wasm', 'LICENSE', 'package.json', 'README.md'];
  execFileSync('tar', ['-xzf', tarball, '-C', work, ...runtimeFiles.map(n => `package/${n}`)], { stdio: 'pipe' });
  const assets = [];
  for (const file of runtimeFiles) {
    const name = `runtime/${file.replace(/^dist\//, '')}`;
    assets.push(await save(name, await readFile(resolve(work, 'package', file))));
  }
  const wasm = await readFile(resolve(assetRoot, 'runtime/prebuilt/kws.wasm'));
  await WebAssembly.compile(wasm);
  await writeFile(resolve(assetRoot, 'runtime-report.json'), JSON.stringify({
    runtime: { package: '@sherpaw/kws', version: runtimeVersion, integrity: `sha512-${runtimeIntegrity}`, license: 'Apache-2.0' },
    assets, wasmCompile: 'PASS', model: 'NOT_PREPARED'
  }, null, 2));
  if (runtimeOnly) return { status: 'RUNTIME_ONLY', assets };
  const metadataResponse = await fetch(`https://huggingface.co/api/models/${repo}/revision/${revisionPrefix}?blobs=true`, { signal: AbortSignal.timeout(60_000) });
  if (!metadataResponse.ok) throw Error('MODEL_METADATA_UNAVAILABLE');
  const metadata = await metadataResponse.json();
  if (!/^[a-f0-9]{40}$/.test(metadata.sha) || !metadata.sha.startsWith(revisionPrefix)) throw Error('MODEL_REVISION_INVALID');
  const revision = metadata.sha;
  const names = {
    'encoder.onnx': 'encoder-epoch-20-avg-2-chunk-16-left-64.onnx',
    'decoder.onnx': 'decoder-epoch-20-avg-2-chunk-16-left-64.onnx',
    'joiner.onnx': 'joiner-epoch-20-avg-2-chunk-16-left-64.onnx',
    'tokens.txt': 'tokens.txt', 'bpe.model': 'bpe.model', 'README.md': 'README.md'
  };
  for (const [local, original] of Object.entries(names)) {
    const bytes = await download(`https://huggingface.co/${repo}/resolve/${revision}/${original}`);
    const remoteHash = metadata.siblings?.find(f => f.rfilename === original)?.lfs?.sha256;
    if (remoteHash && remoteHash !== sha256(bytes)) throw Error('MODEL_INTEGRITY_FAILED');
    if (local.endsWith('.onnx')) checkOnnx(bytes);
    assets.push(await save(`model/${local}`, bytes));
  }
  const bpe = await readFile(resolve(assetRoot, 'model/bpe.model'));
  const tokens = await readFile(resolve(assetRoot, 'model/tokens.txt'), 'utf8');
  const matches = [];
  for (const word of ['atlas', 'ATLAS']) try {
    const parts = keywordTokens(bpe, tokens, word);
    if (!matches.some(p => JSON.stringify(p) === JSON.stringify(parts))) matches.push(parts);
  } catch { }
  if (!matches.length) throw Error('KEYWORD_UNSUPPORTED');
  const manifest = {
    schema: 1, model: { repository: repo, revision, license: 'UNVERIFIED_PERSONAL_EVALUATION_ONLY' },
    runtime: { package: '@sherpaw/kws', version: runtimeVersion }, files: assets, keywords: matches
  };
  await writeFile(resolve(assetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { status: 'PREPARED', modelRevision: revision, assets };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(v => v !== '--runtime-only')) throw Error('ARGUMENT_INVALID');
    console.log(JSON.stringify(await prepare(process.argv.includes('--runtime-only')), null, 2));
  } catch { console.error('SPIKE_PREPARATION_FAILED: no usable model manifest was created. Check approved network access and local preparation requirements.'); process.exitCode = 1; }
}
