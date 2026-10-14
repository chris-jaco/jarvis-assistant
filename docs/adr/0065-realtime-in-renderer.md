# ADR-0065 — Realtime permanece en renderer

- Estado: Implementada en el vertical slice; aceptación acústica/Windows pendiente

OpenAI Realtime, WebRTC, captura de micrófono, playback y Web Audio permanecen inicialmente en el cliente/renderer. Esto conserva el flujo validado y evita introducir un pipeline de audio nativo simultáneamente al shell desktop.

El renderer recibe sólo el secreto efímero a través de `RealtimeTokenProvider`; la API key continúa exclusivamente en backend. Ocultar la ventana detendrá la sesión de voz y liberará tracks. Electron deberá gestionar permisos de micrófono, autoplay, sleep/wake y cleanup, y validarse en Windows real. Hito 0 sólo extrae el provider de token; no cambia VAD, transcripción, voz ni WebRTC.
