# Atlas Desktop — V0.6.1 Hito 1

Estado: vertical slice implementado para validación; aceptación real Windows 11 pendiente.

## Desarrollo

Requisitos: Windows 11, Node.js 22.12 o posterior, dependencias instaladas con `npm ci` y la misma configuración backend privada usada por Atlas Web.

```powershell
git switch v0.5.3-consequential-actions
npm ci
npm run desktop:dev
```

El comando construye web, servidor, extensión y desktop; después abre Electron. No requiere abrir Chrome. Browser Control es opcional y, si no está configurado, no impide voz, memoria ni las demás integraciones.

## Procesos y canal

```text
Electron Main
 ├─ BrowserWindow sandboxed ── preload allowlisted ── Renderer (UI + WebRTC/audio)
 └─ proceso hijo propio ── HTTP 127.0.0.1:puerto aleatorio ── Atlas Core
                           header efímero por lanzamiento
```

Main crea una credencial aleatoria de 32 bytes por lanzamiento y la entrega únicamente al proceso hijo. Todas las rutas `/api/*` del Core en modo desktop la exigen. El renderer no recibe esa credencial: solicita operaciones `CoreTransport` tipadas y el token efímero Realtime mediante IPC cerrado; Main añade autenticación y conserva la cookie HttpOnly de la sesión. No hay IPC de URL o HTTP arbitrario.

El renderer conserva la capacidad de invocar las operaciones Atlas que la UI ya ofrece; por eso un renderer comprometido no se considera una autoridad confiable. Schemas, permisos, confirmaciones, idempotencia, journal y `UNKNOWN` continúan en Core. La mediación reduce exposición de secretos, pero no convierte el renderer en una frontera de autorización.

## Aislamiento y permisos

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- Preload CommonJS dedicado con tres superficies: Core tipado, token efímero y cleanup.
- CSP restrictiva; ventanas nuevas denegadas y navegación limitada al origen local exacto.
- Sólo se concede `media` de audio al renderer Atlas. Cámara y otros permisos se rechazan.
- La API key OpenAI, credenciales OAuth y secreto local nunca llegan al renderer.

## Lifecycle

Electron adquiere el lock de instancia única, inicia un solo Core con `PORT=0`, espera `ATLAS_READY` y verifica `/api/desktop/health` autenticado antes de mostrar la ventana. Cerrar la ventana solicita cleanup del renderer durante un plazo acotado, cierra sesión/medios, solicita shutdown autenticado del Core y sólo termina el hijo que creó si no responde. En Hito 1 cerrar finaliza Atlas; tray queda diferido.

Un crash del Core muestra un error y cierra la aplicación. No se restauran confirmaciones, grants ni ejecuciones inciertas. No hay retries automáticos nuevos.

## Acceptance Windows 11 pendiente

1. Ejecutar `npm run desktop:dev` y comprobar que aparece una ventana independiente sin abrir Chrome.
2. Conectar, conceder micrófono, conversar, comprobar audio/transcripción y hacer barge-in.
3. Desconectar y confirmar que el indicador de micrófono desaparece.
4. Reconectar; cerrar la ventana durante voz y durante una confirmación. Verificar que Electron y su Core hijo terminan y el micrófono se libera.
5. Lanzar dos veces: la segunda ejecución debe enfocar la primera sin otro Core ni otra captura.
6. Ejecutar sin Chrome/Bridge y confirmar que la conversación sigue disponible.
7. Provocar un fallo controlado cerrando únicamente el Core hijo y comprobar el error y cierre acotado.
8. Ejecutar Atlas Web con `npm run dev` y repetir voz básica para comprobar compatibilidad.

No declarar Hito 1 completado hasta verificar estos pasos en Windows real.

## Límites

Sin tray, wake word, instalador, updater, autostart, routing remoto ni background listening. Browser Bridge no se empaqueta. WhatsApp B.2 continúa `PARTIAL / DEFERRED`; B.3 y Send permanecen bloqueados.
