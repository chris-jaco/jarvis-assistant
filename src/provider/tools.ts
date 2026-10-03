import { tool, setSensitiveDataLoggingEnabled } from '@openai/agents-realtime';
import { z } from 'zod';
import type { ToolResult } from '../tools/types.js';
import type { ToolActivity } from '../tools/telemetry.js';
setSensitiveDataLoggingEnabled(false);
export interface PendingConfirmation { confirmationId: string; summary: string; expiresAt: number }
interface Descriptor { id: string; description: string; inputSchema: unknown }
export async function toolRequest(path: string, data?: unknown, method = 'POST'): Promise<unknown> {
  const response = await fetch(`/api/tools/${path}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('No se pudo contactar con las herramientas. Reconecta si la sesión caducó.');
  return response.json();
}
export class VoiceToolBridge {
  pending: PendingConfirmation | null = null;
  private armed = false;
  private promptPlayback?: { confirmationId: string; responseId: string };
  private captured = new Map<string, { id: string; approvable: boolean }>();
  private closed = false;
  private polling?: ReturnType<typeof setInterval>;
  constructor(private readonly activity: (rows: ToolActivity[], pending: PendingConfirmation | null) => void,
    private readonly notify: (message: string) => void) {}
  async initialize() {
    const config = await toolRequest('session', {}) as { tools: Descriptor[]; timezone: string; now: string };
    if (this.closed) { void toolRequest('session', undefined, 'DELETE').catch(() => undefined); return { tools: [], context: '' }; }
    this.polling = setInterval(() => { void this.refresh(); }, 1000);
    return { context: `Zona horaria del usuario: ${config.timezone}. Fecha/hora al conectar: ${config.now}. Usa el reloj de la sesión para resolver fechas relativas.`,
      tools: config.tools.map(descriptor => tool({ name: descriptor.id.replaceAll('.', '_'),
        description: `${descriptor.description}\nEsquema del objeto JSON que debes enviar en inputJson: ${JSON.stringify(descriptor.inputSchema)}`,
        parameters: z.object({ inputJson: z.string() }), timeoutMs: 30_000,
        execute: async ({ inputJson }, _context, details) => {
          if (this.closed) return { status: 'error', message: 'Sesión cerrada.' };
          // Realtime may request another tool before asynchronous user transcription.
          // Never let the model replace/execute a frozen action while it awaits a decision.
          if (this.pending) return { status: 'pending', ...this.pending };
          let input: unknown; try { input = JSON.parse(inputJson); } catch { return { status: 'error', message: 'JSON inválido.' }; }
          try {
            const result = await toolRequest('invoke', { invocationId: details?.toolCall?.callId ?? crypto.randomUUID(), toolId: descriptor.id, input }) as ToolResult;
            if (this.closed) return { status: 'error', message: 'Sesión cerrada.' };
            this.pending = result.status === 'pending' ? result : null; this.armed = false; this.promptPlayback = undefined; this.captured.clear();
            await this.refresh(); return result;
          } catch { return { status: 'error', message: 'La herramienta no respondió. No asumas que la acción se realizó; comprueba su estado antes de repetirla.' }; }
        } })) };
  }
  playbackStarted(responseId: string): void {
    if (this.pending && responseId) this.promptPlayback = { confirmationId: this.pending.confirmationId, responseId };
  }
  playbackFinished(responseId: string): void {
    if (this.pending && this.promptPlayback?.confirmationId === this.pending.confirmationId && this.promptPlayback.responseId === responseId) this.armed = true;
  }
  async transportEvent(event: { type: string; [key: string]: unknown }): Promise<void> {
    switch (event.type) {
      case 'output_audio_buffer.started':
        if (typeof event.response_id === 'string') this.playbackStarted(event.response_id);
        break;
      case 'output_audio_buffer.stopped':
        if (typeof event.response_id === 'string') this.playbackFinished(event.response_id);
        break;
      case 'output_audio_buffer.cleared': this.armed = false; this.promptPlayback = undefined; break;
      case 'input_audio_buffer.speech_started':
        if (typeof event.item_id === 'string') this.speechStarted(event.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.item_id === 'string' && typeof event.transcript === 'string') await this.transcript(event.item_id, event.transcript);
        break;
    }
  }
  speechStarted(itemId: string): void {
    if (!this.captured.has(itemId) && this.pending && this.pending.expiresAt > Date.now()) this.captured.set(itemId, { id: this.pending.confirmationId, approvable: this.armed });
  }
  async transcript(itemId: string, text: string): Promise<void> {
    if (!this.pending || this.closed) return;
    const capture = this.captured.get(itemId); this.captured.delete(itemId);
    const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
    const approved = ['si', 'si confirma', 'confirma', 'confirmar', 'si confirmo', 'confirmo', 'adelante', 'hazlo', 'si hazlo', 'yes'].includes(normalized);
    const rejected = ['no', 'cancela', 'cancelar', 'no lo hagas', 'no cancelalo', 'cancel'].includes(normalized);
    if (rejected && capture?.id === this.pending.confirmationId) { await this.decide(false); return; }
    if (approved && capture?.approvable && capture.id === this.pending.confirmationId) { await this.decide(true); return; }
    // Do not let delayed transcripts or an unrelated utterance approve an action.
    if (capture?.id === this.pending.confirmationId) {
      this.pending = null; this.armed = false;
      await toolRequest('cancel', {}).catch(() => undefined); this.notify('La confirmación se canceló porque el usuario cambió de solicitud.'); await this.refresh();
    }
  }
  async decide(approved: boolean): Promise<void> {
    const pending = this.pending; if (!pending || this.closed) return;
    this.pending = null; this.armed = false; this.promptPlayback = undefined; this.captured.clear();
    try { const result = await toolRequest('decision', { confirmationId: pending.confirmationId, approved });
      if (!this.closed) this.notify(`Resultado del backend para la confirmación ${pending.confirmationId}: ${JSON.stringify(result)}. Comunica el resultado brevemente; no repitas la acción.`);
    } catch { if (!this.closed) this.notify('No se pudo confirmar la acción. No asumas éxito ni repitas una escritura sin comprobar su estado.'); }
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    if (this.closed) return;
    const expectedId = this.pending?.confirmationId;
    try { const data = await toolRequest('activity', undefined, 'GET') as { activity: ToolActivity[]; pending: PendingConfirmation | null };
      if (this.closed) return;
      if (this.pending && this.pending.confirmationId === expectedId && (!data.pending || data.pending.confirmationId !== this.pending.confirmationId)) { this.pending = null; this.armed = false; }
      this.activity(data.activity, this.pending);
    } catch { /* Polling never breaks voice playback. Tool requests report failures. */ }
  }
  close(): void { this.closed = true; clearInterval(this.polling); this.pending = null; this.captured.clear(); void toolRequest('session', undefined, 'DELETE').catch(() => undefined); }
}
