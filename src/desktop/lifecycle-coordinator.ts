export type DesktopLifecycleState =
  | 'STARTING'
  | 'VISIBLE_DISCONNECTED'
  | 'VISIBLE_ACTIVE'
  | 'PREPARING_HIDE'
  | 'HIDDEN_DISCONNECTED'
  | 'VISIBLE_ERROR'
  | 'SHUTTING_DOWN'
  | 'CORE_FAILED'
  | 'TERMINATED';

export type DesktopCleanupOutcome = 'COMPLETED' | 'FAILED' | 'TIMED_OUT';
export type DesktopTerminationReason = 'QUIT' | 'CORE_CRASH';
export type DesktopLifecycleEvent = 'READY' | 'VOICE_CONNECTED' | 'VOICE_DISCONNECTED' | 'HIDE' | 'RESTORE' | 'QUIT' | 'CORE_CRASH';

export interface DesktopLifecycleTransition {
  event: DesktopLifecycleEvent;
  from: DesktopLifecycleState;
  to: DesktopLifecycleState;
  accepted: boolean;
  coalesced: boolean;
  cleanup?: DesktopCleanupOutcome;
}

export interface DesktopLifecycleDependencies {
  cleanupForHide(): Promise<DesktopCleanupOutcome>;
  terminate(reason: DesktopTerminationReason): Promise<void>;
  transition?(transition: DesktopLifecycleTransition): void;
}

const VISIBLE_STATES = new Set<DesktopLifecycleState>(['VISIBLE_DISCONNECTED', 'VISIBLE_ACTIVE', 'VISIBLE_ERROR']);

/**
 * Pure lifecycle authority for Electron Main. It owns ordering and priority but
 * deliberately knows nothing about BrowserWindow, Tray, IPC or real timers.
 * Dependencies perform those effects and tests can control their promises.
 */
export class DesktopLifecycleCoordinator {
  private current: DesktopLifecycleState = 'STARTING';
  private revision = 0;
  private hideOperation?: Promise<DesktopCleanupOutcome>;
  private termination?: Promise<void>;

  constructor(private readonly dependencies: DesktopLifecycleDependencies) {}

  get state(): DesktopLifecycleState { return this.current; }

  ready(active = false): DesktopLifecycleTransition {
    return this.move('READY', this.current === 'STARTING' ? (active ? 'VISIBLE_ACTIVE' : 'VISIBLE_DISCONNECTED') : undefined);
  }

  voiceConnected(): DesktopLifecycleTransition {
    return this.move('VOICE_CONNECTED', this.current === 'VISIBLE_DISCONNECTED' ? 'VISIBLE_ACTIVE' : undefined);
  }

  voiceDisconnected(): DesktopLifecycleTransition {
    return this.move('VOICE_DISCONNECTED', this.current === 'VISIBLE_ACTIVE' ? 'VISIBLE_DISCONNECTED' : undefined);
  }

  hide(): Promise<DesktopCleanupOutcome> {
    if (this.current === 'PREPARING_HIDE' && this.hideOperation) {
      this.emit({ event: 'HIDE', from: this.current, to: this.current, accepted: true, coalesced: true });
      return this.hideOperation;
    }
    if (!VISIBLE_STATES.has(this.current) || this.termination) {
      this.emit({ event: 'HIDE', from: this.current, to: this.current, accepted: false, coalesced: false });
      return Promise.resolve('FAILED');
    }

    const operationRevision = ++this.revision;
    this.move('HIDE', 'PREPARING_HIDE', false, false);
    const operation = Promise.resolve()
      .then(() => this.dependencies.cleanupForHide())
      .catch((): DesktopCleanupOutcome => 'FAILED')
      .then(outcome => {
        if (operationRevision === this.revision && this.current === 'PREPARING_HIDE' && !this.termination) {
          this.move('HIDE', outcome === 'COMPLETED' ? 'HIDDEN_DISCONNECTED' : 'VISIBLE_ERROR', false, false, outcome);
        }
        return outcome;
      })
      .finally(() => { if (this.hideOperation === operation) this.hideOperation = undefined; });
    this.hideOperation = operation;
    return operation;
  }

  restore(): DesktopLifecycleTransition {
    if (this.current !== 'HIDDEN_DISCONNECTED' && this.current !== 'PREPARING_HIDE') {
      return this.move('RESTORE', undefined);
    }
    // Supersede any pending hide result. Restoring never reconnects voice.
    ++this.revision;
    return this.move('RESTORE', 'VISIBLE_DISCONNECTED', false, false);
  }

  quit(): Promise<void> {
    return this.terminate('QUIT');
  }

  coreCrash(): Promise<void> {
    return this.terminate('CORE_CRASH');
  }

  private terminate(reason: DesktopTerminationReason): Promise<void> {
    if (this.current === 'TERMINATED') {
      this.emit({ event: reason, from: this.current, to: this.current, accepted: false, coalesced: true });
      return Promise.resolve();
    }
    if (this.termination) {
      if (reason === 'CORE_CRASH' && this.current !== 'CORE_FAILED') {
        ++this.revision;
        this.move(reason, 'CORE_FAILED', false, false);
      } else {
        this.emit({ event: reason, from: this.current, to: this.current, accepted: true, coalesced: true });
      }
      return this.termination;
    }

    ++this.revision;
    this.move(reason, reason === 'QUIT' ? 'SHUTTING_DOWN' : 'CORE_FAILED', false, false);
    const operation = Promise.resolve()
      .then(() => this.dependencies.terminate(reason))
      .catch(() => undefined)
      .then(() => { this.move(reason, 'TERMINATED', false, false); });
    this.termination = operation;
    return operation;
  }

  private move(
    event: DesktopLifecycleEvent,
    to?: DesktopLifecycleState,
    coalesced = false,
    incrementRevision = true,
    cleanup?: DesktopCleanupOutcome
  ): DesktopLifecycleTransition {
    const from = this.current;
    if (!to || from === 'TERMINATED') {
      const transition = { event, from, to: from, accepted: false, coalesced, ...(cleanup ? { cleanup } : {}) };
      this.emit(transition);
      return transition;
    }
    if (incrementRevision) ++this.revision;
    this.current = to;
    const transition = { event, from, to, accepted: true, coalesced, ...(cleanup ? { cleanup } : {}) };
    this.emit(transition);
    return transition;
  }

  private emit(transition: DesktopLifecycleTransition): void {
    try { this.dependencies.transition?.(transition); } catch { /* Diagnostics never control lifecycle. */ }
  }
}
