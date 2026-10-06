import type { BrowserObservation } from './provider.js';
import type { InteractionResult } from './attached/protocol.js';

export interface MediaPollPort {
  observe(signal: AbortSignal): Promise<BrowserObservation>;
  skip(ref: string, signal: AbortSignal): Promise<InteractionResult>;
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});
// One tool invocation, at most three READ checks. A skip is a distinct reversible
// action through the existing Phase 1 orchestrator, never a READ masquerading as
// a write. No retries of skip, even on stale/unknown/failed post-action READ.
export async function pollMedia(port: MediaPollPort, signal: AbortSignal, options: { sleep?: typeof sleep; now?: () => number } = {}) {
  const now = options.now ?? Date.now; const wait = options.sleep ?? sleep;
  const deadline = now() + 10_000;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let observation: BrowserObservation | undefined; let checks = 0;
  while (checks < 3 && now() < deadline) {
    try { observation = await port.observe(bounded); ++checks; }
    catch (error) {
      if (!signal.aborted && bounded.aborted && observation) return { observation, checks, requiresFreshObservation: true, waitEnded: 'BUDGET_EXHAUSTED' as const };
      throw error;
    }
    signal.throwIfAborted();
    if (bounded.aborted || now() >= deadline) return { observation, checks, requiresFreshObservation: true, waitEnded: 'BUDGET_EXHAUSTED' as const };
    const skip = observation.elements.filter(el => el.functionalKind === 'AD_SKIP' && !el.disabled && el.capabilities?.includes('SKIP_AD'));
    if (observation.media?.advertisement !== 'DETECTED') return { observation, checks, requiresFreshObservation: false, waitEnded: 'STATE_OBSERVED' as const };
    if (skip.length === 1 && observation.media.skipAvailable) {
      const skipped = await port.skip(skip[0]!.ref, bounded);
      return { skip: skipped, checks, requiresFreshObservation: skipped.requiresFreshObservation, waitEnded: 'SKIP_COMPLETED' as const };
    }
    if (checks >= 3) break;
    try { await wait(Math.min(3000, Math.max(0, deadline - now())), bounded); }
    catch (error) {
      if (!signal.aborted && bounded.aborted) return { observation, checks, requiresFreshObservation: true, waitEnded: 'BUDGET_EXHAUSTED' as const };
      throw error;
    }
  }
  return { observation, checks, requiresFreshObservation: !observation, waitEnded: 'BUDGET_EXHAUSTED' as const };
}
