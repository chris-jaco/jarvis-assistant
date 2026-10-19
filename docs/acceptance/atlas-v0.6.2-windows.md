# Atlas V0.6.2 — Windows Packaged Preview

Fecha de cierre: 19 de octubre de 2026. Rama: `v0.6.2-windows-packaging`.
Baseline publicada revisada: `f74dc6b76fdf5164753cec0c84ab364bbc17fdf4`.

## Decisión y alcance

Cierre aprobado como preview personal Windows 11 mediante `win-unpacked`.
Incluye Atlas.exe y runtime Electron, Main/Core desde ASAR, independencia del
repositorio, credenciales cifradas, UI inicial, bootstrap privado, memoria persistente,
voz Realtime, Tray/lifecycle e iconos oficiales. No incluye instalador soportado,
updater, autostart, wake word, firma ni distribución pública. Sin tag/GitHub Release.

## Evidencia y límites

| Área | Evidencia | Límite |
|---|---|---|
| Paquete Windows 11 | Hito 1 informado por el usuario: Atlas.exe empaquetado validado | No se repite ejecución Windows desde Linux |
| Visible/Tray | Auditoría real: seis procesos de la misma imagen; mismos PID oculto | No equivale a exclusión atómica |
| Quit | Cero procesos de esa imagen cinco segundos después de Quit | No prueba todos los escenarios de crash |
| Voz, memoria, Tray/lifecycle | Aceptación Desktop previa; regresiones automatizadas conservadas | No se declara nueva campaña manual completa sobre el paquete 0.6.2 |
| Credenciales y bootstrap | safeStorage, separación userData/ASAR y canal privado cubiertos por tests | No se expone la clave al renderer; sin onboarding OAuth completo |
| NSIS | Configuración inicial publicada; generación soportada deshabilitada al cierre | No instalar/desinstalar: taskkill y exclusión pendientes |
| Detector Win32 | Prueba real: INDETERMINATE, 149 inciertos; 148 QUERY/5 y 1 SYNCHRONIZE/5 | No autoriza mantenimiento |
| CIM | Inventario real: 395 procesos; 236 con ruta, 159 sin ruta, fechas disponibles | No elimina incertidumbre |
| Cobertura combinada | Los 149 inciertos sin ruta CIM; fechas estables, sin contradicción ni rutas recuperadas | Investigación detenida; no ampliar whitelist |

## Auditoría de seguridad de código

- Allowlist de archivos y exclusión de `.env*`, `.local`, credenciales, tokens y journal.
- userData separado de recursos/ASAR; credenciales cifradas fuera del paquete.
- HTTP loopback con credencial efímera y validación de sender/contratos IPC allowlisted.
- Browser Control opcional; permisos, journal y política UNKNOWN sin retries preservados.
- WhatsApp B.2 PARTIAL/DEFERRED; B.3 y Send continúan bloqueados.
- Diagnósticos publicados se conservan como investigación; no son guard de mantenimiento.

## Operación

Generar con `npm run desktop:package:win`, verificar con `npm run desktop:verify-package`
y ejecutar `release/win-unpacked/Atlas.exe`. Distribuir toda la carpeta a un equipo
personal. Salir mediante «Salir de Atlas» antes de copiar, reemplazar o retirar binarios;
no usar `X` como prueba de salida. Si persiste ambigüedad, no modificar archivos.
Preservar userData; no está dentro de la carpeta desempaquetada. No hay actualización,
rollback ni reparación automática ni garantía de exclusión ante arranques concurrentes.

## Validación del cierre

Validación ejecutada en el entorno cloud Linux:

- Typecheck y builds Web, Core, extensión, Desktop, setup/preload: PASS.
- Suite completa: 861 tests, 858 PASS, 3 SKIP existentes, 0 FAIL.
- Generación estándar `desktop:package:win`: PARCIAL / bloqueada por entorno.
  electron-builder 26.0.12 descargó Electron Windows x64 y creó ASAR/Atlas.exe,
  pero falló al editar recursos Windows: `wine is required` y
  `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` (exit 1). No se instaló Wine ni se omitió
  la edición de recursos para declarar un falso éxito.
- `desktop:verify-package`: PASS sobre esa salida parcial; 4398 entradas ASAR,
  453665874 bytes. Manifest del ASAR: versión 0.6.2 y Main esperado.
- Escaneo exterior/unpacked de nombres privados: PASS; ausencia comprobada por el
  verificador dentro de ASAR. Es verificación de estructura y nombres, no búsqueda
  exhaustiva de secretos arbitrarios dentro de todo contenido.
- `git diff --check`: PASS. Comando NSIS bloqueado con exit 1 cubierto por test.

La salida parcial cloud no es un artefacto final distribuible ni demuestra los recursos
oficiales del ejecutable. La generación completa de la versión 0.6.2 debe repetirse
con los comandos documentados en Windows; ejecutar el verificador y comprobar icono,
arranque y operación antes de usar esa nueva carpeta. Esta limitación del entorno no
reabre NSIS ni invalida la decisión de alcance aprobada. No se ejecutó instalación,
desinstalación ni Atlas.exe en este cierre cloud.
