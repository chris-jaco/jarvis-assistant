import type { CoreOperation, CoreOperationMap } from '../provider/core-transport.js';

export interface DesktopRequestOptions { timeoutMs?: number; browserSequence?: number }
export interface DesktopCoreReply<K extends CoreOperation = CoreOperation> {
  data: CoreOperationMap[K]['output'];
  browserCall?: string;
}
export interface AtlasDesktopApi {
  core: {
    request<K extends CoreOperation>(requestId: string, operation: K, input: CoreOperationMap[K]['input'], options?: DesktopRequestOptions): Promise<DesktopCoreReply<K>>;
    cancel(requestId: string): void;
  };
  realtime: { token(): Promise<string> };
  lifecycle: { onShutdown(listener: () => void): () => void; ready(): void };
}

declare global { interface Window { atlasDesktop?: AtlasDesktopApi } }
