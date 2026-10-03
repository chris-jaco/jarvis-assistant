import { JARVIS_INSTRUCTIONS, REALTIME_MODEL } from '../core/personality.js';
export class TokenError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function createClientSecret(apiKey: string | undefined, request: typeof fetch = fetch): Promise<{ value: string }> {
  if (!apiKey?.trim()) throw new TokenError(503, 'Falta OPENAI_API_KEY en el backend.');
  let response: Response;
  try {
    response = await request('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ session: {
        type: 'realtime', model: REALTIME_MODEL, instructions: JARVIS_INSTRUCTIONS,
        output_modalities: ['audio'],
        audio: {
          input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' },
            turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } },
          output: { voice: 'marin' }
        }
      } })
    });
  } catch { throw new TokenError(502, 'No se pudo contactar con OpenAI.'); }
  // Never forward upstream error bodies; they may contain sensitive information.
  if (!response.ok) throw new TokenError(502, 'OpenAI rechazó la autenticación. Revisa la clave y el acceso al modelo en el backend.');
  let data: unknown;
  try { data = await response.json(); } catch { throw new TokenError(502, 'Respuesta de autenticación inválida.'); }
  if (typeof data !== 'object' || data === null || !('value' in data) || typeof data.value !== 'string' || !data.value.startsWith('ek_')) {
    throw new TokenError(502, 'Respuesta de autenticación inválida.');
  }
  return { value: data.value };
}
