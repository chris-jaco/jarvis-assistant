export function updateMemoryInstructions(transport: { sendEvent(event: { type: 'session.update'; session: { type: 'realtime'; instructions: string } }): void }, instructions: string): void {
  // SDK updateSessionConfig(partial) fills voice/VAD defaults in 0.18.0.
  // The official minimal event changes ONLY instructions and preserves live config.
  transport.sendEvent({ type: 'session.update', session: { type: 'realtime', instructions } });
}

// Memory updates never create a response or inject a synthetic user message.
// Automatic VAD/barge-in remains owned by the existing Realtime session.
export class VoiceMemoryBridge {
  private revision = 0;
  private closed = false;
  private seen = new Set<string>();
  private speechSequence = 0;
  private starts = new Map<string, { sequence: number; observedAt: string }>();
  speechStarted(itemId: string): void {
    if (this.closed || this.starts.has(itemId) || this.seen.has(itemId)) return;
    ++this.revision; const sequence = ++this.speechSequence;
    if (!this.confirmationActive()) this.starts.set(itemId, { sequence, observedAt: new Date().toISOString() });
    if (this.starts.size > 100) this.starts.delete(this.starts.keys().next().value!);
  }
  constructor(private readonly update: (context: string) => Promise<unknown>, private readonly confirmationActive: () => boolean,
    private readonly request: typeof fetch = fetch) {}
  async initial(): Promise<string> {
    try {
      const response = await this.request('/api/tools/memory-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'preferencias perfil preferences profile' }), signal: AbortSignal.timeout(2000) });
      if (!response.ok) return ''; const data = await response.json() as { context?: unknown };
      return typeof data.context === 'string' ? data.context.slice(0, 8000) : '';
    } catch { return ''; }
  }
  async turn(itemId: string, utterance: string): Promise<void> {
    if (this.closed || this.confirmationActive() || this.seen.has(itemId)) return;
    const speech = this.starts.get(itemId); this.starts.delete(itemId);
    if (!speech || speech.sequence !== this.speechSequence) return;
    this.seen.add(itemId); if (this.seen.size > 100) return;
    const revision = ++this.revision;
    try {
      // Remove previous-turn/possibly expired context before a new lookup.
      await this.update('');
      if (this.closed || this.confirmationActive() || revision !== this.revision) return;
      const response = await this.request('/api/tools/memory-turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, utterance, ...speech }), signal: AbortSignal.timeout(2000) });
      if (!response.ok) return; const data = await response.json() as { context?: unknown };
      if (!this.closed && !this.confirmationActive() && revision === this.revision && typeof data.context === 'string') await this.update(data.context.slice(0, 8000));
    } catch { /* Optional memory never disconnects Realtime or invents context. */ }
  }
  close(): void { this.closed = true; ++this.revision; this.seen.clear(); this.starts.clear(); }
}
