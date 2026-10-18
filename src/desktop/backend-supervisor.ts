import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createDesktopSecret } from '../server/desktop-auth.js';
import { DesktopBackendClient, DesktopHealthError } from './backend-client.js';
import { allowlistedCoreEnvironment } from './core-environment.js';
import { createCoreBootstrapRequest, parseCoreBootstrapAck, validCoreBootstrapGeneration } from './core-bootstrap-protocol.js';

export interface BackendEndpoint { baseUrl: string; secret: string }
export interface BackendProcess {
  stdout: Readable;
  stderr: Readable;
  once(event: 'spawn' | 'exit' | 'error', listener: (...args: any[]) => void): this;
  on?(event: 'message', listener: (message: unknown) => void): this;
  off?(event: 'message', listener: (message: unknown) => void): this;
  postMessage?(message: unknown): void;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}
export type BackendSpawner = (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => BackendProcess;
export type BackendRuntime = 'node' | 'utility';
export type BackendStartupStage = 'CORE_SPAWN_REQUESTED' | 'CORE_SPAWNED' | 'CORE_BOOTSTRAP_SENT' | 'CORE_BOOTSTRAP_ACK' | 'CORE_BOOTSTRAP_FAILED' | 'CORE_STDOUT_OBSERVED' | 'CORE_READY_RECEIVED' | 'CORE_EXITED_EARLY' | 'CORE_READINESS_TIMEOUT' | 'CORE_HEALTH_STARTED' | 'CORE_HEALTH_OK' | 'CORE_HEALTH_FAILED';
export interface BackendStartupDiagnostic { stage: BackendStartupStage; elapsedMs: number; pidPresent?: boolean; exitCode?: number | null; healthFailure?: 'UNAUTHORIZED' | 'NOT_READY' | 'CONNECTION_FAILED' | 'TIMEOUT' }

export function backendEnvironment(base: NodeJS.ProcessEnv, secret: string, runtime: BackendRuntime, bootstrapGeneration?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...allowlistedCoreEnvironment(base), ATLAS_DESKTOP_MODE: 'true', ATLAS_DESKTOP_SECRET: secret, HOST: '127.0.0.1', PORT: '0' };
  if (bootstrapGeneration !== undefined) {
    if (!validCoreBootstrapGeneration(bootstrapGeneration)) throw new Error('DESKTOP_CORE_BOOTSTRAP_INVALID');
    env.ATLAS_CREDENTIAL_BOOTSTRAP_GENERATION = bootstrapGeneration;
  }
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

  async start(bootstrap?: { generation: string; openAIKey: string }): Promise<BackendEndpoint> {
    if (this.child) throw new Error('DESKTOP_BACKEND_ALREADY_STARTED');
    const secret = createDesktopSecret();
    const spawner: BackendSpawner = this.options.spawn ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    const startedAt = performance.now();
    const emit = (event: Omit<BackendStartupDiagnostic, 'elapsedMs'>) => {
      const diagnostic = { ...event, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) };
      try { (this.options.diagnostic ?? defaultDiagnostic)(diagnostic); } catch { /* Diagnostics never affect startup. */ }
    };
    emit({ stage: 'CORE_SPAWN_REQUESTED' });
    const child = spawner(this.options.executable, [this.options.serverEntry], {
      cwd: this.options.cwd,
      env: backendEnvironment(this.options.environment ?? process.env, secret, this.options.runtime ?? 'node', bootstrap?.generation)
    });
    let startupComplete = false;
    this.child = child; this.expectedExit = false;
    child.once('spawn', () => emit({ stage: 'CORE_SPAWNED', pidPresent: child.pid !== undefined }));
    child.stderr.resume();
    const endpoint = await new Promise<BackendEndpoint>((resolve, reject) => {
      let settled = false; let buffered = ''; let stdoutObserved = false; let readyPort: number | undefined; let bootstrapAccepted = bootstrap === undefined; let bootstrapSent = false;
      const messageListener = (message: unknown) => {
        if (!bootstrap) return;
        const ack = parseCoreBootstrapAck(message);
        if (!ack || ack.generation !== bootstrap.generation || ack.status !== 'ACCEPTED' || bootstrapAccepted) {
          emit({ stage: 'CORE_BOOTSTRAP_FAILED' }); finish(new Error('DESKTOP_CORE_BOOTSTRAP_REJECTED')); return;
        }
        bootstrapAccepted = true; emit({ stage: 'CORE_BOOTSTRAP_ACK' }); maybeReady();
      };
      const cleanup = () => child.off?.('message', messageListener);
      const finish = (error?: Error, value?: BackendEndpoint) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); error ? reject(error) : resolve(value!); };
      const maybeReady = () => { if (bootstrapAccepted && readyPort !== undefined) finish(undefined, { baseUrl: `http://127.0.0.1:${readyPort}`, secret }); };
      const timer = setTimeout(() => { emit({ stage: 'CORE_READINESS_TIMEOUT', pidPresent: child.pid !== undefined }); finish(new Error('DESKTOP_BACKEND_START_TIMEOUT')); }, this.options.startupTimeoutMs ?? 15_000);
      if (bootstrap) {
        if (!child.on || !child.postMessage) { emit({ stage: 'CORE_BOOTSTRAP_FAILED' }); finish(new Error('DESKTOP_CORE_BOOTSTRAP_CHANNEL_UNAVAILABLE')); return; }
        child.on('message', messageListener);
        child.once('spawn', () => {
          if (settled || bootstrapSent) return;
          bootstrapSent = true;
          try { child.postMessage!(createCoreBootstrapRequest(bootstrap.generation, bootstrap.openAIKey)); emit({ stage: 'CORE_BOOTSTRAP_SENT' }); }
          catch { emit({ stage: 'CORE_BOOTSTRAP_FAILED' }); finish(new Error('DESKTOP_CORE_BOOTSTRAP_SEND_FAILED')); }
        });
      }
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        if (!stdoutObserved) { stdoutObserved = true; emit({ stage: 'CORE_STDOUT_OBSERVED' }); }
        buffered = (buffered + String(chunk)).slice(-4096);
        const match = /(?:^|\n)ATLAS_READY (\d{1,5})(?:\r?\n|$)/.exec(buffered);
        if (!match) return; const port = Number(match[1]);
        if (port < 1 || port > 65535) { finish(new Error('DESKTOP_BACKEND_INVALID_READY')); return; }
        emit({ stage: 'CORE_READY_RECEIVED', pidPresent: child.pid !== undefined });
        readyPort = port; maybeReady();
      });
      child.once('error', () => finish(new Error('DESKTOP_BACKEND_START_FAILED')));
      child.once('exit', code => {
        if (this.child === child) { this.child = undefined; this.client?.dispose(); this.client = undefined; }
        if (!settled) { emit({ stage: 'CORE_EXITED_EARLY', exitCode: code }); finish(new Error('DESKTOP_BACKEND_EXITED_EARLY')); }
        if (!this.expectedExit && startupComplete) this.options.onUnexpectedExit?.(code);
      });
    }).catch(async error => { await this.forceStop(); throw error; });
    if (this.child !== child) throw new Error('DESKTOP_BACKEND_EXITED_DURING_STARTUP');
    this.client = this.options.clientFactory?.(endpoint) ?? new DesktopBackendClient(endpoint.baseUrl, endpoint.secret);
    emit({ stage: 'CORE_HEALTH_STARTED' });
    await this.client.health().then(() => {
      if (this.child !== child) throw new Error('DESKTOP_BACKEND_EXITED_DURING_HEALTH');
      emit({ stage: 'CORE_HEALTH_OK' }); startupComplete = true;
    }).catch(async error => {
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
