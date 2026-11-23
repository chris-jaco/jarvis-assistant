import {
  CORE_BOOTSTRAP_PROTOCOL,
  parseCoreBootstrapRequest,
  validCoreBootstrapGeneration
} from '../desktop/core-bootstrap-protocol.js';
import type { CoreCredentials, CoreBootstrapAck, CoreBootstrapRejectReason } from '../desktop/core-bootstrap-protocol.js';

export class CoreCredentialBootstrapReceiver {
  private accepted = false;
  constructor(readonly generation: string) {
    if (!validCoreBootstrapGeneration(generation)) throw new Error('CORE_BOOTSTRAP_GENERATION_INVALID');
  }

  accept(value: unknown): { ack: CoreBootstrapAck; credentials?: CoreCredentials } {
    const request = parseCoreBootstrapRequest(value);
    let reason: CoreBootstrapRejectReason | undefined;
    if (!request) reason = 'INVALID_MESSAGE';
    else if (request.generation !== this.generation) reason = 'GENERATION_MISMATCH';
    else if (this.accepted) reason = 'DUPLICATE';
    if (reason) return { ack: { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation: this.generation, status: 'REJECTED', reason } };
    this.accepted = true;
    return {
      ack: { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation: this.generation, status: 'ACCEPTED' },
      credentials: request!.credentials
    };
  }
}

export async function receiveCoreCredentialBootstrap(port: Electron.ParentPort | undefined, generation: string, timeoutMs = 10_000): Promise<CoreCredentials> {
  if (!port) throw new Error('CORE_BOOTSTRAP_CHANNEL_UNAVAILABLE');
  const receiver = new CoreCredentialBootstrapReceiver(generation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, credentials?: CoreCredentials) => {
      if (settled) return;
      settled = true; clearTimeout(timer); port.off('message', onMessage);
      error ? reject(error) : resolve(credentials!);
    };
    const onMessage = (event: Electron.MessageEvent) => {
      const result = receiver.accept(event.data);
      port.postMessage(result.ack);
      if (result.credentials) finish(undefined, result.credentials);
      else finish(new Error(`CORE_BOOTSTRAP_${result.ack.status === 'REJECTED' ? result.ack.reason : 'INVALID'}`));
    };
    const timer = setTimeout(() => finish(new Error('CORE_BOOTSTRAP_TIMEOUT')), timeoutMs);
    port.on('message', onMessage);
  });
}
