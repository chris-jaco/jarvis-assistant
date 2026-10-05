import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioLevels, normalizedEnergy, smoothEnergy } from './audio-levels.js';
import type { AudioRuntime } from './audio-levels.js';
test('energy normalizes silence, whispers, speech and clipping with attack/release smoothing', () => {
  assert.equal(normalizedEnergy(new Float32Array(512)), 0); assert.ok(normalizedEnergy(new Float32Array(512).fill(.01)) > 0);
  assert.ok(normalizedEnergy(new Float32Array(512).fill(.1)) > normalizedEnergy(new Float32Array(512).fill(.01)));
  assert.equal(normalizedEnergy(new Float32Array(512).fill(2)), 1); assert.equal(normalizedEnergy(new Float32Array([NaN])), 0);
  assert.ok(smoothEnergy(0, 1, .016) > 0); assert.ok(smoothEnergy(0, 1, .016) < 1); assert.ok(smoothEnergy(1, 0, .016) > .5);
});
test('analyzers tap existing streams without capture/playback changes and release every resource across reconnects', () => {
  const listeners = new Set<string>(); const frames = new Map<number, FrameRequestCallback>(); let next = 0; let closes = 0; let resumes = 0; let disconnects = 0; let destinations = 0; let stopTracks = 0;
  const input = { getAudioTracks: () => [{}], getTracks: () => [{ stop: () => { stopTracks++; } }] } as unknown as MediaStream;
  const output = { getAudioTracks: () => [{}] } as unknown as MediaStream;
  const taps: MediaStream[] = [];
  const context = { resume: async () => { resumes++; }, close: async () => { closes++; }, createMediaStreamSource: (stream: MediaStream) => { taps.push(stream); return { connect: (target: unknown) => { if (target === 'destination') destinations++; }, disconnect: () => { disconnects++; } }; }, createAnalyser: () => ({ fftSize: 512, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(taps.length > 1 ? .1 : .05), disconnect: () => { disconnects++; } }), destination: 'destination' } as unknown as AudioContext;
  const runtime: AudioRuntime = { context: () => context, frame: callback => { const id = ++next; frames.set(id, callback); return id; }, cancel: id => { frames.delete(id); } };
  const audio = { srcObject: null, paused: false, muted: false, volume: 1, addEventListener: (name: string) => listeners.add(name), removeEventListener: (name: string) => listeners.delete(name) } as unknown as HTMLAudioElement;
  const levels: number[][] = []; const analyzer = new AudioLevels(audio, (a, b) => levels.push([a, b]), runtime);
  const tick = (time: number) => { const [id, callback] = [...frames.entries()][0]!; frames.delete(id); callback(time); };
  analyzer.start(input); assert.equal(taps[0], input); audio.srcObject = output; tick(16); assert.equal(taps[1], output); assert.ok(levels.at(-1)![0]! > 0); assert.ok(levels.at(-1)![1]! > 0);
  const stale = [...frames.values()][0]!; analyzer.stop(); assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(closes, 1); assert.equal(disconnects, 4);
  analyzer.start(input); const count = frames.size; stale(32); assert.equal(frames.size, count); analyzer.stop(); assert.equal(closes, 2); assert.equal(resumes, 2); assert.equal(destinations, 0); assert.equal(stopTracks, 0);
});
test('unavailable audio analysis does not throw or affect voice capture', () => {
  const levels: unknown[] = []; const audio = { removeEventListener: () => {} } as unknown as HTMLAudioElement;
  const analyzer = new AudioLevels(audio, (a, b) => levels.push([a, b]), { context: () => { throw new Error('Unavailable'); }, frame: () => 0, cancel: () => {} });
  assert.doesNotThrow(() => analyzer.start({} as MediaStream)); assert.deepEqual(levels.at(-1), [0, 0]);
});
test('user-gesture preparation is reused for capture and closed if connection is cancelled', () => {
  let creations = 0; let closes = 0; const audio = { srcObject: null, addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLAudioElement;
  const runtime: AudioRuntime = { context: () => { creations++; return { resume: async () => {}, close: async () => { closes++; }, createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }), createAnalyser: () => ({ fftSize: 512, disconnect: () => {} }) } as unknown as AudioContext; }, frame: () => 1, cancel: () => {} };
  const analyzer = new AudioLevels(audio, () => {}, runtime); analyzer.prepare(); analyzer.start({} as MediaStream); assert.equal(creations, 1); analyzer.stop(); assert.equal(closes, 1);
  analyzer.prepare(); analyzer.stop(); assert.equal(creations, 2); assert.equal(closes, 2);
});
