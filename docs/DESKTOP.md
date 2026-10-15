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
# Desktop performance baseline (Windows 11)

`scripts/desktop-perf-sampler.ps1` is a development-only, read-only process sampler. It identifies the single Electron Main launched from the current checkout, follows only that process tree, and identifies Atlas Core as the unique descendant that owns a loopback listener. It stops safely if either identity is ambiguous. Command lines are used only for local classification and are never exported.

Build and start Atlas from the repository in the first PowerShell window:

```powershell
cd C:\Users\chris\jarvis-assistant
git switch v0.6.1-desktop-companion
npm ci
npm run desktop:dev
```

In a second PowerShell window, validate the pure fixture checks and take the initial ten-minute sample:

```powershell
cd C:\Users\chris\jarvis-assistant
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\desktop-perf-sampler.ps1 -SelfTest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\desktop-perf-sampler.ps1 `
  -DurationSeconds 600 `
  -IntervalSeconds 5 `
  -OutputPath .\desktop-perf-baseline.csv
```

PowerShell 7 can use `pwsh` instead of `powershell.exe`. The output path must not already exist, preventing accidental overwrite. The sampler creates only the requested CSV and does not stop processes, change permissions, inspect conversation data, or export command lines, ports, URLs, cookies, tokens, prompts, or secrets.

Each active process produces one row per sample. `ProcessState` is `NEW`, `PRESENT`, or `DISAPPEARED`; disappeared rows deliberately leave resource values empty. Roles are `MAIN`, `RENDERER`, `CORE`, and `AUXILIARY`. `CpuPercentInterval` is normalized across the machine's logical processors, while `CpuTotalSeconds` is cumulative. `LocalTcpConnections` counts loopback TCP entries owned by the process.

Interpret memory only after a warm-up period. Short increases followed by a plateau are normal; a reproducible positive slope across settled samples is the signal to investigate. Compare equivalent states (idle with idle, connected with connected), and retain the raw CSV rather than relying only on the console summary. A ten-minute run establishes tooling and baseline shape; it does not replace the one-hour and twenty-cycle Hito 3 acceptance runs.
