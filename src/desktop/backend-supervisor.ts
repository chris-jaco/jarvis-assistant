import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createDesktopSecret } from '../server/desktop-auth.js';
import { DesktopBackendClient, DesktopHealthError } from './backend-client.js';
import { allowlistedCoreEnvironment } from './core-environment.js';

export interface BackendEndpoint { baseUrl: string; secret: string }
export interface BackendProcess {
  stdout: Readable;
  stderr: Readable;
  once(event: 'spawn' | 'exit' | 'error', listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}
export type BackendSpawner = (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => BackendProcess;
export type BackendRuntime = 'node' | 'utility';
export type BackendStartupStage = 'CORE_SPAWN_REQUESTED' | 'CORE_SPAWNED' | 'CORE_STDOUT_OBSERVED' | 'CORE_READY_RECEIVED' | 'CORE_EXITED_EARLY' | 'CORE_READINESS_TIMEOUT' | 'CORE_HEALTH_STARTED' | 'CORE_HEALTH_OK' | 'CORE_HEALTH_FAILED';
export interface BackendStartupDiagnostic { stage: BackendStartupStage; elapsedMs: number; pidPresent?: boolean; exitCode?: number | null; healthFailure?: 'UNAUTHORIZED' | 'NOT_READY' | 'CONNECTION_FAILED' | 'TIMEOUT' }

export function backendEnvironment(base: NodeJS.ProcessEnv, secret: string, runtime: BackendRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...allowlistedCoreEnvironment(base), ATLAS_DESKTOP_MODE: 'true', ATLAS_DESKTOP_SECRET: secret, HOST: '127.0.0.1', PORT: '0' };
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export class BackendSupervisor {
  private child?: BackendProcess;
  private client?: DesktopBackendClient;
  private expectedExit = false;
  constructor(private readonly options: {
    executable: string;
    serverEntry: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    startupTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    spawn?: BackendSpawner;
    runtime?: BackendRuntime;
    diagnostic?: (event: BackendStartupDiagnostic) => void;
    clientFactory?: (endpoint: BackendEndpoint) => DesktopBackendClient;
    onUnexpectedExit?: (code: number | null) => void;
  }) {}

  async start(): Promise<BackendEndpoint> {
    if (this.child) throw new Error('DESKTOP_BACKEND_ALREADY_STARTED');
    const secret = createDesktopSecret();
    const spawner = this.options.spawn ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    const startedAt = performance.now();
    const emit = (event: Omit<BackendStartupDiagnostic, 'elapsedMs'>) => {
      const diagnostic = { ...event, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) };
      try { (this.options.diagnostic ?? defaultDiagnostic)(diagnostic); } catch { /* Diagnostics never affect startup. */ }
    };
    emit({ stage: 'CORE_SPAWN_REQUESTED' });
    const child = spawner(this.options.executable, [this.options.serverEntry], {
      cwd: this.options.cwd,
      env: backendEnvironment(this.options.environment ?? process.env, secret, this.options.runtime ?? 'node')
    });
    this.child = child; this.expectedExit = false;
    child.once('spawn', () => emit({ stage: 'CORE_SPAWNED', pidPresent: child.pid !== undefined }));
    child.stderr.resume();
    const endpoint = await new Promise<BackendEndpoint>((resolve, reject) => {
      let settled = false; let buffered = ''; let stdoutObserved = false;
      const finish = (error?: Error, value?: BackendEndpoint) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
      const timer = setTimeout(() => { emit({ stage: 'CORE_READINESS_TIMEOUT', pidPresent: child.pid !== undefined }); finish(new Error('DESKTOP_BACKEND_START_TIMEOUT')); }, this.options.startupTimeoutMs ?? 15_000);
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (!stdoutObserved) { stdoutObserved = true; emit({ stage: 'CORE_STDOUT_OBSERVED' }); }
        buffered = (buffered + String(chunk)).slice(-4096);
        const match = /(?:^|\n)ATLAS_READY (\d{1,5})(?:\r?\n|$)/.exec(buffered);
        if (!match) return; const port = Number(match[1]);
        if (port < 1 || port > 65535) { finish(new Error('DESKTOP_BACKEND_INVALID_READY')); return; }
        emit({ stage: 'CORE_READY_RECEIVED', pidPresent: child.pid !== undefined });
        finish(undefined, { baseUrl: `http://127.0.0.1:${port}`, secret });
      });
      child.once('error', () => finish(new Error('DESKTOP_BACKEND_START_FAILED')));
      child.once('exit', code => {
        if (this.child === child) { this.child = undefined; this.client?.dispose(); this.client = undefined; }
        if (!settled) { emit({ stage: 'CORE_EXITED_EARLY', exitCode: code }); finish(new Error('DESKTOP_BACKEND_EXITED_EARLY')); }
        if (!this.expectedExit) this.options.onUnexpectedExit?.(code);
      });
    }).catch(async error => { await this.forceStop(); throw error; });
    this.client = this.options.clientFactory?.(endpoint) ?? new DesktopBackendClient(endpoint.baseUrl, endpoint.secret);
    emit({ stage: 'CORE_HEALTH_STARTED' });
    await this.client.health().then(() => emit({ stage: 'CORE_HEALTH_OK' })).catch(async error => {
      emit({ stage: 'CORE_HEALTH_FAILED', healthFailure: error instanceof DesktopHealthError ? error.failure : 'CONNECTION_FAILED' });
      await this.stop(); throw error;
    });
    return endpoint;
  }

  backendClient(): DesktopBackendClient {
    if (!this.client) throw new Error('DESKTOP_BACKEND_NOT_STARTED');
    return this.client;
  }

  async stop(): Promise<void> {
    const child = this.child; if (!child) return;
    this.expectedExit = true;
    await this.client?.shutdown();
    await Promise.race([
      new Promise<void>(resolve => child.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, this.options.shutdownTimeoutMs ?? 2_000))
    ]);
    if (this.child) child.kill('SIGTERM');
    this.client?.dispose(); this.client = undefined; this.child = undefined;
  }

  private async forceStop(): Promise<void> {
    this.expectedExit = true; this.client?.dispose(); this.client = undefined;
    this.child?.kill('SIGTERM'); this.child = undefined;
  }
}

function defaultDiagnostic(event: BackendStartupDiagnostic): void {
  console.info(`[ATLAS desktop] ${JSON.stringify(event)}`);
}
