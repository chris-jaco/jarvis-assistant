// Diagnostics accept only explicit metadata, never raw Realtime events or request bodies.
export interface ConfirmationTrace {
  event: string;
  reason: string;
  responseId?: string;
  itemId?: string;
  pendingId?: string;
  capturedId?: string;
  promptResponseId?: string;
  armed?: boolean;
  capturedApprovable?: boolean;
  classification?: 'affirmative' | 'negative' | 'correction' | 'unrelated' | 'ambiguous';
}
export type TraceSink = (entry: ConfirmationTrace) => void;
function opaqueId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  // Correlate opaque IDs between browser/server without printing any original value.
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return `id-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
export function confirmationTracer(enabled: boolean, sink: TraceSink = entry => console.info('[JARVIS confirmation]', JSON.stringify(entry))): TraceSink {
  return entry => {
    if (!enabled) return;
    // Whitelist fields explicitly. Even accidental extra properties cannot escape.
    const safe: ConfirmationTrace = { event: entry.event, reason: entry.reason,
      responseId: opaqueId(entry.responseId), itemId: opaqueId(entry.itemId),
      pendingId: opaqueId(entry.pendingId), capturedId: opaqueId(entry.capturedId),
      promptResponseId: opaqueId(entry.promptResponseId), armed: entry.armed,
      capturedApprovable: entry.capturedApprovable, classification: entry.classification };
    try { sink(safe); } catch { /* Diagnostics must never change execution. */ }
  };
}
