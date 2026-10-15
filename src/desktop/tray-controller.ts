export interface DesktopTrayIcon {
  isEmpty(): boolean;
}

export interface DesktopTrayMenuItem {
  label: 'Abrir Atlas' | 'Salir de Atlas';
  click(): void;
}

export interface DesktopTrayTarget {
  on(event: 'click', listener: () => void): unknown;
  removeListener(event: 'click', listener: () => void): unknown;
  setToolTip(value: string): void;
  setContextMenu(menu: unknown): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface DesktopTrayScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface DesktopTrayActions {
  restore(): unknown;
  quit(): unknown;
}

export interface DesktopTrayDependencies {
  loadIcon(): DesktopTrayIcon;
  createTray(icon: DesktopTrayIcon): DesktopTrayTarget;
  buildMenu(items: readonly DesktopTrayMenuItem[]): unknown;
  actions: DesktopTrayActions;
  scheduler?: DesktopTrayScheduler;
  restoreCoalesceMs?: number;
}

type DesktopTrayControllerState = 'NEW' | 'AVAILABLE' | 'UNAVAILABLE' | 'DISPOSED';

const DEFAULT_SCHEDULER: DesktopTrayScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Owns only the native Tray surface. Lifecycle state and effects remain owned by
 * DesktopLifecycleRuntime; this controller can merely request restore or quit.
 */
export class DesktopTrayController {
  private state: DesktopTrayControllerState = 'NEW';
  private tray?: DesktopTrayTarget;
  private pendingRestore?: unknown;
  private quitting = false;
  private readonly scheduler: DesktopTrayScheduler;
  private readonly restoreCoalesceMs: number;
  private readonly click = () => this.requestRestore();

  constructor(private readonly dependencies: DesktopTrayDependencies) {
    this.scheduler = dependencies.scheduler ?? DEFAULT_SCHEDULER;
    const delay = dependencies.restoreCoalesceMs ?? 225;
    this.restoreCoalesceMs = Number.isFinite(delay) && delay >= 0 ? delay : 225;
  }

  get available(): boolean {
    if (this.state !== 'AVAILABLE' || this.quitting || !this.tray) return false;
    try { return !this.tray.isDestroyed(); } catch { return false; }
  }

  canHideSafely(): boolean { return this.available; }

  initialize(): boolean {
    if (this.state !== 'NEW') return this.available;

    let created: DesktopTrayTarget | undefined;
    try {
      const icon = this.dependencies.loadIcon();
      if (!icon || icon.isEmpty()) throw new Error('DESKTOP_TRAY_ICON_INVALID');

      created = this.dependencies.createTray(icon);
      const menu = this.dependencies.buildMenu([
        { label: 'Abrir Atlas', click: () => this.requestRestore() },
        { label: 'Salir de Atlas', click: () => this.requestQuit() }
      ]);
      created.setToolTip('Atlas');
      created.setContextMenu(menu);
      created.on('click', this.click);

      this.tray = created;
      this.state = 'AVAILABLE';
      return true;
    } catch {
      if (created) this.destroy(created);
      this.state = 'UNAVAILABLE';
      return false;
    }
  }

  dispose(): void {
    if (this.state === 'DISPOSED') return;
    this.cancelPendingRestore();
    this.quitting = true;
    const tray = this.tray;
    this.tray = undefined;
    this.state = 'DISPOSED';
    if (tray) {
      try { tray.removeListener('click', this.click); } catch { /* Best-effort listener cleanup. */ }
      this.destroy(tray);
    }
  }

  private requestRestore(): void {
    if (!this.available || this.pendingRestore !== undefined) return;
    this.pendingRestore = this.scheduler.schedule(() => {
      this.pendingRestore = undefined;
      if (!this.available) return;
      this.invoke(this.dependencies.actions.restore);
    }, this.restoreCoalesceMs);
  }

  private requestQuit(): void {
    if (!this.available) return;
    this.quitting = true;
    this.cancelPendingRestore();
    this.invoke(this.dependencies.actions.quit);
  }

  private cancelPendingRestore(): void {
    if (this.pendingRestore === undefined) return;
    try { this.scheduler.cancel(this.pendingRestore); } catch { /* Cancellation cannot authorize restore. */ }
    this.pendingRestore = undefined;
  }

  private invoke(action: () => unknown): void {
    try {
      const result = action();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch { /* Lifecycle action failures never create an alternate effect path. */ }
  }

  private destroy(tray: DesktopTrayTarget): void {
    try { if (!tray.isDestroyed()) tray.destroy(); } catch { /* Availability remains fail-closed. */ }
  }
}
