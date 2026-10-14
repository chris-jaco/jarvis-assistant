export const DESKTOP_CLEANUP_REQUEST_CHANNEL = 'atlas:lifecycle-cleanup-request';
export const DESKTOP_CLEANUP_RESULT_CHANNEL = 'atlas:lifecycle-cleanup-result';

export type DesktopCleanupReason = 'HIDE' | 'QUIT' | 'CORE_CRASH';
export type DesktopCoreCleanupState = 'CLOSED' | 'NOT_OPEN' | 'FAILED';
export type DesktopExecutionDisposition = 'IDLE' | 'UNKNOWN';
export type DesktopCleanupFailureReason =
  | 'LOCAL_CLEANUP_FAILED'
  | 'CORE_SESSION_CLOSE_FAILED'
  | 'EXECUTION_UNKNOWN';

export interface DesktopCleanupRequest {
  requestId: string;
  reason: DesktopCleanupReason;
}

export interface DesktopCleanupResult {
  requestId: string;
  status: 'COMPLETED' | 'FAILED';
  local: {
    microphoneReleased: boolean;
    realtimeClosed: boolean;
    audioStopped: boolean;
  };
  core: {
    state: DesktopCoreCleanupState;
    pendingConfirmationCancelled: boolean;
    execution: DesktopExecutionDisposition;
  };
  failureReason?: DesktopCleanupFailureReason;
}

export type DesktopRendererCleanupReport = Omit<DesktopCleanupResult, 'requestId'>;

export type DesktopCleanupOutcome = DesktopCleanupResult | {
  requestId: string;
  status: 'TIMED_OUT';
};

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasons = new Set<DesktopCleanupReason>(['HIDE', 'QUIT', 'CORE_CRASH']);
const failureReasons = new Set<DesktopCleanupFailureReason>(['LOCAL_CLEANUP_FAILED', 'CORE_SESSION_CLOSE_FAILED', 'EXECUTION_UNKNOWN']);

export function validDesktopCleanupRequest(value: unknown): value is DesktopCleanupRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DesktopCleanupRequest>;
  return typeof request.requestId === 'string' && requestIdPattern.test(request.requestId) && reasons.has(request.reason as DesktopCleanupReason);
}

export function validDesktopCleanupResult(value: unknown): value is DesktopCleanupResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DesktopCleanupResult>;
  if (typeof result.requestId !== 'string' || !requestIdPattern.test(result.requestId) || !['COMPLETED', 'FAILED'].includes(String(result.status))) return false;
  const local = result.local as DesktopCleanupResult['local'] | undefined;
  const core = result.core as DesktopCleanupResult['core'] | undefined;
  if (!local || !core || !['microphoneReleased', 'realtimeClosed', 'audioStopped'].every(key => typeof local[key as keyof typeof local] === 'boolean')) return false;
  if (!['CLOSED', 'NOT_OPEN', 'FAILED'].includes(core.state) || typeof core.pendingConfirmationCancelled !== 'boolean' || !['IDLE', 'UNKNOWN'].includes(core.execution)) return false;
  if (result.status === 'COMPLETED') return result.failureReason === undefined && local.microphoneReleased && local.realtimeClosed && local.audioStopped && core.state !== 'FAILED' && core.execution === 'IDLE';
  return failureReasons.has(result.failureReason as DesktopCleanupFailureReason);
}

export interface DesktopCleanupIpc {
  on(channel: string, listener: (event: { sender: { id: number } }, value: unknown) => void): void;
  removeListener(channel: string, listener: (event: { sender: { id: number } }, value: unknown) => void): void;
}

export interface DesktopCleanupTarget {
  send(channel: string, request: DesktopCleanupRequest): void;
}

export interface DesktopCleanupClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: DesktopCleanupClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Main-side correlation authority. Electron integration is intentionally deferred. */
export class DesktopCleanupProtocol {
  private pending?: {
    request: DesktopCleanupRequest;
    promise: Promise<DesktopCleanupOutcome>;
    resolve(outcome: DesktopCleanupOutcome): void;
    timeout: unknown;
  };
  private readonly listener: (event: { sender: { id: number } }, value: unknown) => void;

  constructor(
    private readonly ipc: DesktopCleanupIpc,
    private readonly target: DesktopCleanupTarget,
    private readonly trustedSender: (senderId: number) => boolean,
    private readonly timeoutMs = 5_000,
    private readonly createRequestId = () => crypto.randomUUID(),
    private readonly clock: DesktopCleanupClock = systemClock
  ) {
    this.listener = (event, value) => this.receive(event.sender.id, value);
    ipc.on(DESKTOP_CLEANUP_RESULT_CHANNEL, this.listener);
  }

  request(reason: DesktopCleanupReason): Promise<DesktopCleanupOutcome> {
    if (this.pending) return this.pending.promise;
    const requestId=this.createRequestId();
    const candidate:unknown={requestId,reason};
    if (!validDesktopCleanupRequest(candidate)) return Promise.resolve({ requestId, status: 'TIMED_OUT' });
    const request=candidate;
    let resolve!: (outcome: DesktopCleanupOutcome) => void;
    const promise = new Promise<DesktopCleanupOutcome>(done => { resolve = done; });
    const timeout = this.clock.setTimeout(() => {
      if (this.pending?.request.requestId !== request.requestId) return;
      this.pending = undefined;
      resolve({ requestId: request.requestId, status: 'TIMED_OUT' });
    }, this.timeoutMs);
    this.pending = { request, promise, resolve, timeout };
    try { this.target.send(DESKTOP_CLEANUP_REQUEST_CHANNEL, request); }
    catch {
      this.clock.clearTimeout(timeout);
      this.pending = undefined;
      resolve({ requestId: request.requestId, status: 'TIMED_OUT' });
    }
    return promise;
  }

  abort(): void {
    const pending = this.pending;
    if (!pending) return;
    this.clock.clearTimeout(pending.timeout);
    this.pending = undefined;
    pending.resolve({ requestId: pending.request.requestId, status: 'TIMED_OUT' });
  }

  dispose(): void {
    this.abort();
    this.ipc.removeListener(DESKTOP_CLEANUP_RESULT_CHANNEL, this.listener);
  }

  private receive(senderId: number, value: unknown): void {
    const pending = this.pending;
    if (!pending || !this.trustedSender(senderId) || !validDesktopCleanupResult(value) || value.requestId !== pending.request.requestId) return;
    this.clock.clearTimeout(pending.timeout);
    this.pending = undefined;
    pending.resolve(value);
  }
}
