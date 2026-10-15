import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIVoiceProvider } from '../provider/openai.js';
import { VoiceToolBridge } from '../provider/tools.js';
import type { CoreTransport } from '../provider/core-transport.js';
import { AudioLevels, type AudioRuntime } from './audio-levels.js';
import { DesktopLifecycleRuntime } from '../desktop/lifecycle-runtime.js';
import type { DesktopCleanupOutcome } from '../desktop/cleanup-protocol.js';

const closed = { closed: true, pendingConfirmationCancelled: false, execution: 'IDLE' as const };

function providerFixture() {
  let pauses = 0;
  const provider = new OpenAIVoiceProvider(
    { state: () => {}, transcript: () => {}, microphone: () => {}, tools: () => {} },
    { pause: () => { pauses++; }, srcObject: null, muted: false, paused: true, ended: true } as unknown as HTMLAudioElement,
    { core: { request: async () => closed } as unknown as CoreTransport }
  );
  return { provider, pauses: () => pauses };
}

type ProviderInternals = {
  tools?: VoiceToolBridge;
  session?: { close(): void };
  stream?: { getTracks(): Array<{ readonly readyState: string; stop(): void }> };
};

test('twenty owned voice session teardown cycles release each track, session and bridge exactly once', async () => {
  const f = providerFixture();
  const internal = f.provider as unknown as ProviderInternals;
  let trackStops = 0;
  let sessionCloses = 0;
  let bridgeCloses = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    let readyState = 'live';
    internal.tools = new VoiceToolBridge(() => {}, () => {}, undefined, undefined, undefined, {
      request: async (operation: string) => { assert.equal(operation, 'session.close'); bridgeCloses++; return closed; }
    } as unknown as CoreTransport);
    internal.session = { close: () => { sessionCloses++; } };
    internal.stream = { getTracks: () => [{ get readyState() { return readyState; }, stop: () => { readyState = 'ended'; trackStops++; } }] };
    f.provider.disconnect('USER_DISCONNECT');
    assert.equal(internal.tools, undefined);
    assert.equal(internal.session, undefined);
    assert.equal(internal.stream, undefined);
  }
  await Promise.resolve();
  assert.deepEqual({ trackStops, sessionCloses, bridgeCloses, pauses: f.pauses() }, { trackStops: 20, sessionCloses: 20, bridgeCloses: 20, pauses: 20 });
});

test('late VoiceToolBridge close from a previous generation cannot close or replace a new session', async () => {
  let releaseOld!: (value: typeof closed) => void;
  let oldCloses = 0;
  let newCloses = 0;
  const oldClose = new Promise<typeof closed>(resolve => { releaseOld = resolve; });
  const f = providerFixture();
  const internal = f.provider as unknown as ProviderInternals;
  const oldBridge = new VoiceToolBridge(() => {}, () => {}, undefined, undefined, undefined, {
    request: async (operation: string) => { assert.equal(operation, 'session.close'); oldCloses++; return oldClose; }
  } as unknown as CoreTransport);
  internal.tools = oldBridge;
  internal.session = { close: () => {} };
  internal.stream = { getTracks: () => [] };
  f.provider.disconnect('RECONNECT');

  const newBridge = new VoiceToolBridge(() => {}, () => {}, undefined, undefined, undefined, {
    request: async (operation: string) => { assert.equal(operation, 'session.close'); newCloses++; return closed; }
  } as unknown as CoreTransport);
  const newSession = { close: () => {} };
  const newStream = { getTracks: () => [] };
  internal.tools = newBridge;
  internal.session = newSession;
  internal.stream = newStream;
  releaseOld(closed);
  await oldBridge.closeAndWait('RECONNECT');

  assert.equal(internal.tools, newBridge);
  assert.equal(internal.session, newSession);
  assert.equal(internal.stream, newStream);
  assert.deepEqual({ oldCloses, newCloses }, { oldCloses: 1, newCloses: 0 });
  f.provider.disconnect('USER_DISCONNECT');
  await Promise.resolve();
  assert.equal(newCloses, 1);
});

test('twenty initialized VoiceToolBridges leave no polling timer or duplicate close request', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const active = new Set<number>();
  let nextTimer = 0;
  let creates = 0;
  let closes = 0;
  globalThis.setInterval = ((() => { const id = ++nextTimer; active.add(id); return id; }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => { active.delete(handle as unknown as number); }) as typeof clearInterval;
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const bridge = new VoiceToolBridge(() => {}, () => {}, undefined, undefined, undefined, {
        request: async (operation: string) => {
          if (operation === 'session.create') { creates++; return { tools: [], timezone: 'UTC', now: '2026-10-15T00:00:00.000Z' }; }
          assert.equal(operation, 'session.close'); closes++; return closed;
        }
      } as unknown as CoreTransport);
      await bridge.initialize();
      assert.equal(active.size, 1);
      const first = bridge.closeAndWait('USER_DISCONNECT');
      const duplicate = bridge.closeAndWait('UNKNOWN');
      assert.equal(first, duplicate);
      await first;
      assert.equal(active.size, 0);
    }
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  assert.deepEqual({ creates, closes, active: active.size }, { creates: 20, closes: 20, active: 0 });
});

test('twenty audio visualization cycles release contexts, frames and listeners without stopping owned voice tracks', () => {
  const listeners = new Set<string>();
  const frames = new Set<number>();
  let nextFrame = 0;
  let contexts = 0;
  let contextCloses = 0;
  let sourceDisconnects = 0;
  let analyserDisconnects = 0;
  let trackStops = 0;
  const audio = { srcObject: null, paused: true, muted: false, volume: 1,
    addEventListener: (name: string) => { listeners.add(name); }, removeEventListener: (name: string) => { listeners.delete(name); }
  } as unknown as HTMLAudioElement;
  const runtime: AudioRuntime = {
    context: () => {
      contexts++;
      return { resume: async () => {}, close: async () => { contextCloses++; },
        createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => { sourceDisconnects++; } }),
        createAnalyser: () => ({ fftSize: 512, disconnect: () => { analyserDisconnects++; } })
      } as unknown as AudioContext;
    },
    frame: () => { const id = ++nextFrame; frames.add(id); return id; },
    cancel: id => { frames.delete(id); }
  };
  const levels = new AudioLevels(audio, () => {}, runtime);
  for (let cycle = 0; cycle < 20; cycle++) {
    const stream = { getAudioTracks: () => [{}], getTracks: () => [{ stop: () => { trackStops++; } }] } as unknown as MediaStream;
    levels.prepare();
    levels.start(stream);
    assert.deepEqual({ listeners: listeners.size, frames: frames.size }, { listeners: 1, frames: 1 });
    levels.stop();
    assert.deepEqual({ listeners: listeners.size, frames: frames.size }, { listeners: 0, frames: 0 });
  }
  assert.deepEqual({ contexts, contextCloses, sourceDisconnects, analyserDisconnects, trackStops },
    { contexts: 20, contextCloses: 20, sourceDisconnects: 20, analyserDisconnects: 20, trackStops: 0 });
});

test('twenty Hide/Restore cycles reuse one lifecycle without reconnecting voice, stopping Core or retrying actions', async () => {
  let requests = 0;
  let hides = 0;
  let restores = 0;
  let coreStops = 0;
  const runtime = new DesktopLifecycleRuntime({
    cleanup: {
      request: async reason => {
        assert.equal(reason, 'HIDE');
        requests++;
        return { requestId: crypto.randomUUID(), status: 'COMPLETED', local: { microphoneReleased: true, realtimeClosed: true, audioStopped: true }, core: { state: 'CLOSED', pendingConfirmationCancelled: false, execution: 'IDLE' } } as DesktopCleanupOutcome;
      },
      dispose: () => {}
    },
    ipc: { abortPending: () => {}, dispose: () => {} },
    hideWindow: () => { hides++; }, restoreWindow: () => { restores++; }, destroyWindow: () => {},
    stopCore: async () => { coreStops++; }, showHideFailure: async () => {}, showCoreCrash: async () => {}, quitApplication: () => {}
  });
  runtime.ready();
  for (let cycle = 0; cycle < 20; cycle++) {
    assert.equal(await runtime.hide(), 'COMPLETED');
    assert.equal(runtime.state, 'HIDDEN_DISCONNECTED');
    assert.equal(runtime.restore(), true);
    assert.equal(runtime.state, 'VISIBLE_DISCONNECTED');
  }
  assert.deepEqual({ requests, hides, restores, coreStops }, { requests: 20, hides: 20, restores: 20, coreStops: 0 });
});
