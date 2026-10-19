# Atlas Desktop — V0.6.2 Windows Packaged Preview

Estado: cierre de preview personal empaquetada para Windows 11, 19 de octubre de 2026.

V0.6.2 utiliza `win-unpacked`; no incluye instalador soportado, auto-updater,
autostart, wake word ni distribución pública. No es un instalador ni una aplicación
portable con datos dentro de la carpeta: los datos persistentes permanecen en userData.

## Generar y ejecutar el paquete Windows

Desde el checkout de la rama `v0.6.2-windows-packaging`, con Node.js 22.12 o posterior:

```powershell
npm ci
npm run desktop:package:win
npm run desktop:verify-package
& .\release\win-unpacked\Atlas.exe
```

La generación compila Web, Core, extensión, Desktop y preload; electron-builder genera
el target `dir`. Copiar **toda** la carpeta `win-unpacked`, no sólo Atlas.exe. El equipo
que ejecuta el paquete no necesita el repositorio ni Node global. La extensión/Native
Messaging de Browser Control no se instala con el paquete y sigue siendo opcional.

En el primer inicio, la UI solicita la API key y Main la guarda cifrada mediante
`electron.safeStorage`. Falla cerrado si el cifrado no está disponible. Main entrega
la clave a Core mediante bootstrap privado; no se incluye en ASAR ni se entrega al renderer principal de voz.
Esto no convierte las demás integraciones OAuth en un onboarding empaquetado completo.

## Reemplazar o retirar una carpeta de paquete

1. Usar «Salir de Atlas» desde Tray o el menú. `X` sólo oculta: no termina Atlas/Core.
2. Esperar el shutdown completo y comprobar que no quedan procesos asociados a esa
   copia. Si no se puede confirmar su salida, no sobrescribir ni borrar la carpeta.
3. Preparar la nueva carpeta por separado; no extraer una versión sobre otra activa.
4. Conservar userData, normalmente `%APPDATA%\Atlas` en Windows, y abrir una sola copia.

No hay exclusión atómica ni migración/reparación automática. No iniciar Atlas mientras
se copian o eliminan sus binarios. Sobrescribir archivos activos puede dejar un paquete
parcial o inconsistente. La compatibilidad de upgrade/downgrade de datos no está validada.

userData contiene configuración, credenciales cifradas, memoria, journal, logs y caché,
fuera de ASAR y del directorio del paquete. No copiar esos datos al paquete ni publicarlos.
El cifrado está ligado al contexto del sistema/usuario; copiar userData a otra cuenta o
equipo no garantiza descifrado. Retirar una carpeta de binarios no requiere borrar userData.

## NSIS diferido y diagnósticos

`npm run desktop:installer:win` devuelve error sin compilar ni generar un instalador.
La configuración `build.nsis` conservada es investigación histórica; el único target
Windows por defecto es `dir`. No ejecutar electron-builder con un target NSIS explícito:
el flujo estándar puede cerrar procesos y no cumple la política de Atlas.

Los modos `--summary` y `--coverage` de `scripts/check-atlas-processes.ts` son herramientas
de investigación. En Windows, Win32/CIM mantuvieron procesos inaccesibles e INDETERMINATE.
No son autorización para modificar archivos ni ofrecen exclusión frente a nuevos arranques.
La investigación queda detenida en V0.6.2. Detalle en
`docs/acceptance/atlas-v0.6.2-process-detector.md`.

## Desarrollo en Windows 11

Requisitos: Node.js 22.12 o posterior, dependencias instaladas con `npm ci` y la misma configuración backend privada utilizada por Atlas Web.

```powershell
cd $env:USERPROFILE\jarvis-assistant
git switch v0.6.2-windows-packaging
npm ci
npm run desktop:dev
```

El comando construye Web, servidor/Core, extensión y Desktop/preload; después abre Electron. Chrome no es necesario para la experiencia Desktop básica. Browser Control es opcional y su ausencia no impide utilizar voz, memoria ni las demás integraciones.

## Arquitectura y autenticación local

```text
Electron Main
 ├─ System Tray + lifecycle coordinator/runtime
 ├─ BrowserWindow sandboxed ── preload allowlisted ── Renderer (UI + WebRTC/audio)
 └─ UtilityProcess propio, código en ASAR ── HTTP 127.0.0.1:puerto aleatorio ── Atlas Core
                           header efímero por lanzamiento
```

Electron Main es propietario de la ventana, el Tray y el Core supervisado. El renderer conserva la UI y los recursos WebRTC/audio. Atlas Core mantiene herramientas, memoria, autorizaciones, confirmaciones y journal.

Main crea una credencial aleatoria de 32 bytes por lanzamiento y la entrega únicamente al Core hijo. Las rutas `/api/*` en modo Desktop exigen esa credencial. El renderer no la recibe: usa contratos IPC allowlisted y tipados; Main agrega la autenticación y conserva la cookie HttpOnly de sesión. No existe IPC de URL o HTTP arbitrario.

El renderer no es una autoridad de seguridad. Schemas, permisos, confirmaciones, idempotencia, journal y semántica `UNKNOWN` continúan siendo autoritativos en Core.

## Aislamiento

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- Preload CommonJS dedicado con superficies tipadas para Core, token Realtime y cleanup.
- CSP restrictiva; ventanas nuevas denegadas y navegación limitada al origen local esperado.
- Sólo se concede audio al renderer Atlas. Cámara y otros permisos se rechazan.
- API keys, credenciales OAuth y secreto local no se entregan al renderer.
- Core no se reinicia automáticamente después de un crash.

## Lifecycle actual

| Acción | Resultado |
|---|---|
| Minimizar (`—`) | Mantiene la conversación, WebRTC y micrófono activos. |
| Cerrar (`X`) | Ejecuta cleanup verificado, termina la sesión conversacional, libera voz/micrófono y oculta Atlas. Electron Main y Core permanecen activos. Si el cleanup no termina como `COMPLETED`, Atlas permanece visible y desconectado. |
| Restaurar desde Tray | Muestra la misma ventana y el mismo Core con una conversación nueva. La voz permanece desconectada hasta una conexión explícita. |
| Clic o `Abrir Atlas` en Tray | Utiliza la misma ruta de restore; eventos repetidos se coalescen. |
| `Ctrl+Q`, menú nativo o `Salir de Atlas` | Ejecuta shutdown ordenado, destruye el Tray, detiene Core y termina Electron. |
| Core crash | Restaura la ventana si estaba oculta, detiene voz y micrófono, muestra un error y termina sin autorreinicio ni retry de acciones sensibles. |

La memoria persistente es independiente de la sesión conversacional: cerrar con `X` descarta el contexto/transcript de esa sesión, pero no borra memoria persistente, configuración, permisos ni journal.

Tras una pérdida de Internet no existe reconexión automática; el usuario debe iniciar una nueva conexión. La pérdida y recuperación del micrófono se validaron, pero permanece `NOT_VERIFIED` si la recuperación concreta requiere reconexión manual o se produce automáticamente.

## System Tray e identidad visual

El Tray se crea una sola vez al iniciar Electron y usa `public/brand/atlas-tray.ico`. El tooltip es `Atlas` y el menú ofrece `Abrir Atlas` y `Salir de Atlas`. La identidad oficial utiliza fondo `#10121F`, símbolo `#2DECDD` y bordes redondeados en los assets de aplicación y Tray.

La política es fail-visible: si el Tray no está disponible, `X` no puede ocultar Atlas sin una vía accesible de restauración. La recuperación del icono después de reiniciar Windows Explorer fue validada en Windows 11.

## Fallos y acciones sensibles

- Un timeout de cleanup nunca se interpreta como éxito.
- `UNKNOWN` no significa cancelación y no habilita retries automáticos.
- Ocultar la UI no se considera prueba de cancelación de una acción remota.
- Un crash o shutdown invalida operaciones pendientes según sus contratos, sin restaurar autoridad operativa.
- Browser Control B.2 continúa `PARTIAL / DEFERRED`; B.3 y Send permanecen bloqueados.

## Sampler de rendimiento

`scripts/desktop-perf-sampler.ps1` es una herramienta de desarrollo read-only. Identifica el Electron Main del checkout, sigue únicamente su árbol de procesos y clasifica el Core mediante su listener loopback. Falla de forma cerrada si la identidad es ambigua. No exporta command lines, puertos, URLs, cookies, tokens, prompts ni contenido conversacional.

Con Atlas iniciado, ejecutar en otra ventana de PowerShell:

```powershell
cd $env:USERPROFILE\jarvis-assistant
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\desktop-perf-sampler.ps1 -SelfTest

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\desktop-perf-sampler.ps1 `
  -DurationSeconds 600 `
  -IntervalSeconds 5 `
  -OutputPath .\desktop-perf-baseline.csv
```

PowerShell 7 puede usar `pwsh`. El CSV registra timestamp, rol, PID, working set, memoria privada, CPU acumulada y por intervalo, handles, threads y conexiones TCP locales. `ProcessState` distingue `NEW`, `PRESENT` y `DISAPPEARED`; los roles son `MAIN`, `RENDERER`, `CORE` y `AUXILIARY`.

El baseline aceptado de diez minutos registró 88 muestras y siete procesos estables. La memoria privada total pasó de 244,89 MiB a 243,86 MiB (-1,03 MiB), con CPU en reposo prácticamente nula y un pico auxiliar transitorio posteriormente liberado. El intervalo efectivo medio fue 6,89 segundos porque la captura se suma a la espera configurada. Este baseline no demuestra ausencia de fugas bajo uso intensivo o durante una hora.

## Validación V0.6.1

En Windows 11 se validaron voz Realtime, memoria persistente, barge-in, lifecycle de ventana, Tray, identidad visual, recuperación de Explorer, Core crash visible y oculto, ausencia observable de procesos huérfanos, 20/20 ciclos de conexión/desconexión, 20/20 ciclos Hide/Restore, conversación de aproximadamente 15 minutos, pérdida/recuperación de red y pérdida/recuperación del micrófono.

El registro completo está en `docs/acceptance/atlas-v0.6.1-windows.md`.

## Limitaciones conocidas

- Preview local: sin instalador, firma, auto-updater ni autostart.
- Sin wake word ni escucha en segundo plano.
- Sin empaquetado del Browser Bridge; Browser Control sigue siendo opcional.
- No se completaron mediciones continuas de una hora visible u oculta ni una medición de recursos posterior a carga intensiva.
- El modo exacto de recuperación del micrófono permanece `NOT_VERIFIED`.
- WhatsApp B.2 permanece `PARTIAL / DEFERRED`; B.3 y cualquier Send real permanecen deshabilitados.
