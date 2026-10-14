import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createDesktopSecret } from '../server/desktop-auth.js';
import { DesktopBackendClient } from './backend-client.js';

export interface BackendEndpoint { baseUrl: string; secret: string }
export interface BackendProcess {
  stdout: Readable;
  stderr: Readable;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}
export type BackendSpawner = (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => BackendProcess;

export class BackendSupervisor {
  private child?: BackendProcess;
  private client?: DesktopBackendClient;
  private expectedExit = false;
  constructor(private readonly options: {
    executable: string;
    serverEntry: string;
    cwd: string;
    startupTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    spawn?: BackendSpawner;
    clientFactory?: (endpoint: BackendEndpoint) => DesktopBackendClient;
    onUnexpectedExit?: (code: number | null) => void;
  }) {}

  async start(): Promise<BackendEndpoint> {
    if (this.child) throw new Error('DESKTOP_BACKEND_ALREADY_STARTED');
    const secret = createDesktopSecret();
    const spawner = this.options.spawn ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    const child = spawner(this.options.executable, [this.options.serverEntry], {
      cwd: this.options.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ATLAS_DESKTOP_MODE: 'true', ATLAS_DESKTOP_SECRET: secret, HOST: '127.0.0.1', PORT: '0' }
    });
    this.child = child; this.expectedExit = false;
    const endpoint = await new Promise<BackendEndpoint>((resolve, reject) => {
      let settled = false; let buffered = '';
      const finish = (error?: Error, value?: BackendEndpoint) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
      const timer = setTimeout(() => finish(new Error('DESKTOP_BACKEND_START_TIMEOUT')), this.options.startupTimeoutMs ?? 15_000);
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffered = (buffered + String(chunk)).slice(-4096);
        const match = /(?:^|\n)ATLAS_READY (\d{1,5})(?:\r?\n|$)/.exec(buffered);
        if (!match) return; const port = Number(match[1]);
        if (port < 1 || port > 65535) { finish(new Error('DESKTOP_BACKEND_INVALID_READY')); return; }
        finish(undefined, { baseUrl: `http://127.0.0.1:${port}`, secret });
      });
      child.once('error', () => finish(new Error('DESKTOP_BACKEND_START_FAILED')));
      child.once('exit', code => {
        if (this.child === child) { this.child = undefined; this.client?.dispose(); this.client = undefined; }
        if (!settled) finish(new Error('DESKTOP_BACKEND_EXITED_EARLY'));
        if (!this.expectedExit) this.options.onUnexpectedExit?.(code);
      });
    }).catch(async error => { await this.forceStop(); throw error; });
    this.client = this.options.clientFactory?.(endpoint) ?? new DesktopBackendClient(endpoint.baseUrl, endpoint.secret);
    await this.client.health().catch(async error => { await this.stop(); throw error; });
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
