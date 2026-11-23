// Each Start owns its cancellation, deadline and native resources. A late media
// permission/result belongs to its original attempt even after another Start.
export type CallState = 'idle' | 'connecting' | 'connected' | 'error';
export interface CallScope {
  signal: AbortSignal;
  own(dispose: () => void): void;
  connected(): void;
  fail(): void;
}

export function createCallController(notify: (state: CallState) => void, deadlineMs = 30_000) {
  let active: AbortController | undefined;
  function stop(state: CallState = 'idle') {
    const attempt = active;
    active = undefined;
    attempt?.abort();
    notify(state);
  }
  async function start(connect: (scope: CallScope) => Promise<void>) {
    if (active) return;
    const attempt = new AbortController();
    active = attempt;
    const signal = attempt.signal;
    const cleanups: Array<() => void> = [];
    const fail = () => { if (active === attempt) stop('error'); };
    const timer = setTimeout(fail, deadlineMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      for (const dispose of cleanups.reverse()) {
        try { dispose(); } catch { /* finish releasing other resources */ }
      }
    }, { once: true });
    notify('connecting');
    try {
      await connect({
        signal, fail,
        own(dispose) { if (signal.aborted) dispose(); else cleanups.push(dispose); },
        connected() {
          if (active !== attempt) return;
          clearTimeout(timer);
          notify('connected');
        }
      });
    } catch { fail(); }
  }
  return { start, stop };
}
