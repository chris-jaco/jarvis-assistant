// Local measurements only. No audio, transcript, credentials, or estimated usage.
export class SessionMetrics {
  private started = 0;
  connectionMs: number | null = null;
  detectedTurns = 0;
  interruptions = 0;
  reset(): void { this.started = performance.now(); this.connectionMs = null; this.detectedTurns = 0; this.interruptions = 0; }
  connected(): void { this.connectionMs = Math.round(performance.now() - this.started); }
}
