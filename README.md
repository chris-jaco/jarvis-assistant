# JARVIS V0.1

Asistente personal por voz en el navegador: OpenAI Realtime, WebRTC y OpenAI Agents SDK (`@openai/agents-realtime`, paquete oficial independiente para reducir dependencias). UI TypeScript sin framework y backend Node con HTTP nativo. La clave permanente nunca se entrega al navegador.

## Requirements

- Node.js >= 22.12 y npm.
- Navegador con WebRTC, micrófono y reproducción de audio. Recomendados Chrome/Edge actuales; usar auriculares para evitar eco.
- Internet y una cuenta OpenAI con facturación y acceso al modelo `gpt-realtime-2.1` y transcripción `gpt-4o-mini-transcribe`.
- `localhost` o HTTPS para obtener permisos de micrófono.

## Installation

```bash
cd /workspace/jarvis-assistant
npm install --cache .npm-cache
cp .env.example .env
```

## Environment

Añade tu clave real únicamente en `.env` en la raíz:

```dotenv
OPENAI_API_KEY=tu_clave
PORT=3000
HOST=127.0.0.1
```

`.env` está ignorado por Git. No uses variables `VITE_` para secretos. También se puede inyectar `OPENAI_API_KEY` al proceso del backend. Reinicia el servidor tras cambiar la configuración.

El backend recibe `POST /api/realtime/token` y llama a `POST https://api.openai.com/v1/realtime/client_secrets` con la clave permanente. Devuelve solamente `value`, un token efímero `ek_`, con `Cache-Control: no-store`. El navegador lo usa en `RealtimeSession.connect`; el SDK negocia WebRTC con OpenAI. No se almacena el token en localStorage ni se registra. La configuración usa la API GA y audio anidado; no usa `/realtime/sessions` ni cabeceras beta.

## Development

```bash
npm run dev
```

Abre **http://localhost:3000**. Un único servidor proporciona UI y endpoint; Vite funciona como middleware de desarrollo.

```bash
npm run typecheck
npm test
npm run build
npm start
```

`npm start` sirve el build de producción en la misma URL. No hay lint configurado. El lockfile fija las versiones instaladas.

El servidor escucha en loopback de forma predeterminada. Para una vista previa cloud, configura `HOST=0.0.0.0` y usa la URL HTTPS que proporcione el entorno. Antes de publicar en Internet añade autenticación de usuarios, límites por usuario y protección del endpoint contra abuso; la comprobación de origen y la exclusión de solicitudes simultáneas incluidas no sustituyen esas medidas.

## Usage

1. Pulsa **Conectar** y permite el micrófono.
2. En `connected`, habla normalmente. `listening` indica voz detectada; `speaking` indica reproducción de JARVIS.
3. Deja de hablar: semantic VAD delimita el turno y solicita la respuesta. Puedes hablar mientras responde para interrumpirlo o pulsar **Interrumpir**.
4. Si el navegador bloquea la reproducción, pulsa **Activar audio**.
5. **Desconectar** cierra WebRTC y detiene los tracks del micrófono. También puedes cancelar durante `connecting`.

Estados: `disconnected`, `connecting`, `connected`, `listening`, `speaking`, `error`. Se conserva contexto en la sesión activa. Reconectar crea una conversación nueva y limpia la transcripción. La transcripción del usuario es asíncrona y puede llegar después de comenzar la respuesta. El historial del SDK refleja actualizaciones y truncamientos; una transcripción no garantiza que se haya oído todo su texto.

No se guarda memoria persistente, audio ni transcripciones en el backend. Se desactiva tracing del SDK. El navegador muestra únicamente tiempo de conexión medido con `performance.now()`, turnos de voz detectados y detecciones de interrupción durante reproducción. No se calculan tokens, costes ni uso estimado.

## Architecture

```text
src/core/          contrato de provider, estados y personalidad centralizada
src/provider/      adaptador OpenAI Agents SDK / WebRTC; reserva para local
src/client/        UI, controles y presentación de transcripción
src/server/        servidor HTTP y autenticación efímera; tests del contrato
src/telemetry/     métricas locales reales
src/router/        reserva documentada, sin implementación
src/tools/         reserva documentada, sin implementación
src/memory/        reserva documentada, sin implementación
src/integrations/  reserva documentada, sin implementación
```

Las instrucciones y el modelo están centralizados en `src/core/personality.ts`. `VoiceProvider` permite añadir otro proveedor más adelante. Los puntos de extensión son documentación, no servicios ficticios. No se incluyen Calendar, Gmail, Drive, Notion, HubSpot, Home Assistant, n8n, MCP, wake word, Android ni fallback local.

## Pruebas manuales y barge-in

- Sin clave: conectar debe mostrar un error claro del backend y liberar el micrófono.
- Denegar micrófono: debe aparecer un error de permisos; permitirlo y reconectar.
- Con clave válida: comprobar respuesta hablada, transcripciones de ambos participantes y estados.
- Contexto: di «Me llamo Ana» y después «¿Cómo me llamo?» sin desconectar.
- Barge-in: pide una explicación larga. Mientras habla, di «Para, responde en una frase». Debe detener el audio previo, escuchar y responder al nuevo turno. Repite con auriculares y verifica el botón Interrumpir.
- Desconecta mientras conecta y mientras habla; verifica que se apaga el indicador de micrófono. Reconecta y confirma que no se conserva el contexto previo.
- Corta la red: debe aparecer un error de conexión y permitir reconectar. Un fallo ICE puede tardar unos segundos en notificarse.
- Comprueba en Network que el endpoint devuelve un `ek_` temporal y que la clave permanente no está en los assets ni las respuestas.

Los tests automatizados cubren clave ausente, endpoint/configuración de tokens, respuesta mínima, validación del token y ocultación de errores sensibles. No requieren clave ni simulan una conversación exitosa con OpenAI.

## Documentación oficial consultada

Consulta realizada el 3 de octubre de 2026. La documentación oficial de OpenAI Agents JS consultada recomienda el modelo `gpt-realtime-2.1`, WebRTC en navegador y tokens efímeros vía `client_secrets`:

- [Quickstart oficial](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/) ([fuente oficial consultada](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/voice-agents/quickstart.mdx)).
- [Building voice agents](https://openai.github.io/openai-agents-js/guides/voice-agents/build/) ([fuente](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/voice-agents/build.mdx)): configuración GA, turn detection, contexto e interrupciones.
- [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc/): enlace oficial desde el quickstart. Este sitio devolvió HTTP 403 en el entorno; se consultaron las fuentes oficiales del SDK en GitHub y sus ejemplos de configuración y VAD.

La disponibilidad del modelo depende de la cuenta. No se ha probado una llamada real a OpenAI ni acceso al modelo, micrófono físico, reproducción, VAD o barge-in en este entorno. Esas verificaciones requieren navegador y clave real.
