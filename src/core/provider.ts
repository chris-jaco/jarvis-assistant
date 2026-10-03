import type { ToolActivity } from '../tools/telemetry.js';
import type { PendingConfirmation } from '../provider/tools.js';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking' | 'error';
export interface TranscriptEntry { id: string; role: 'user' | 'assistant'; text: string }
export interface VoiceProvider {
  connect(): Promise<void>;
  disconnect(): void;
  interrupt(): void;
}
export interface ProviderObserver {
  state(state: ConnectionState, message?: string): void;
  transcript(entries: TranscriptEntry[]): void;
  tools?(rows: ToolActivity[], pending: PendingConfirmation | null): void;
}
