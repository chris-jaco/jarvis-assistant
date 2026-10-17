# Atlas V0.6.1 — Registro de aceptación Windows

**Fecha:** 17 de octubre de 2026

**Edición:** Desktop Companion, preview local de desarrollo

**Plataforma:** Windows 11

**Rama:** `v0.6.1-desktop-companion`

## Alcance

La aceptación cubre el shell Electron, Atlas Core supervisado, voz Realtime, memoria persistente, lifecycle de ventana, System Tray, identidad visual, resiliencia ante Core crash y estabilidad básica. No cubre instalador, actualización automática, autostart, wake word, escucha en segundo plano ni distribución pública.

Browser Control B.2 permanece `PARTIAL / DEFERRED`. B.3 y Send permanecen bloqueados y no forman parte de esta aceptación.

## Entorno y privacidad

Las pruebas manuales se realizaron en Windows 11 con la aplicación ejecutada desde el checkout de desarrollo. Este documento no contiene nombres personales, transcripciones, destinatarios, IDs de sesión, tokens, URLs privadas ni secretos.

## Matriz de aceptación

| Área / escenario | Cobertura | Resultado | Evidencia y límite |
|---|---|---|---|
| Electron independiente de Chrome | Manual | PASS | Ventana Desktop y Core supervisado operativos sin usar Chrome como UI. |
| Voz Realtime y memoria persistente | Manual + automatizada | PASS | Conversación bidireccional y memoria disponibles. |
| Minimizar | Manual + automatizada | PASS | Conserva conversación y micrófono. |
| `X` / Hide | Manual + automatizada | PASS | Cleanup verificado, micrófono liberado y ventana oculta. |
| Restore desde Tray | Manual + automatizada | PASS | Misma ventana/Core, conversación nueva y sin reconexión automática. |
| Quit | Manual + automatizada | PASS | `Ctrl+Q`, menú nativo y Tray terminan Electron y Core. |
| System Tray e identidad visual | Manual + automatizada | PASS | Iconos oficiales, Abrir/Salir y lifecycle integrados. |
| Reinicio de Windows Explorer | Manual | PASS | El icono del Tray reapareció sin recuperación adicional. |
| Core crash visible y oculto | Manual + automatizada | PASS | Error visible, cleanup y terminación sin autorreinicio. |
| Procesos huérfanos tras crash/quit | Manual + automatizada | PASS | No se detectaron procesos huérfanos en las pruebas realizadas. |
| 20 ciclos connect/disconnect | Manual + automatizada | PASS | 20/20; sin degradación perceptible ni micrófonos retenidos. |
| 20 ciclos Hide/Restore | Manual + automatizada | PASS | 20/20; sin reconexión automática ni duplicación de Core. |
| 20 ciclos minimize/restore | Parcial | NO VERIFICADO | Comportamiento individual validado; no se ejecutó una serie manual equivalente de 20 ciclos. |
| Conversación prolongada | Manual | PASS | Aproximadamente 15 minutos sin fallos observados. |
| Barge-in repetido | Manual + automatizada | PASS | Interrupciones de voz operativas. |
| Pérdida y recuperación de Internet | Manual | PASS | Pérdida detectada; al recuperar red no se reconectó automáticamente. |
| Pérdida y recuperación de micrófono | Manual | PARCIAL | Recuperación observada; es `NOT_VERIFIED` si fue manual o automática. |
| Quit después de uso prolongado | Parcial | NO VERIFICADO | Quit está validado, pero no se aisló este escenario al final de la misma sesión prolongada. |
| Una hora visible e inactiva | Parcial | NO VERIFICADO | Baseline de diez minutos disponible. |
| Una hora oculta en Tray | No ejecutada | NO VERIFICADO | Lifecycle oculto validado por ciclos, no por duración de una hora. |
| Compatibilidad Atlas Web | Automatizada | PASS | Suite y builds conservan el transporte Web. |

## Validación automatizada

La validación de cierre ejecuta typecheck, suite completa, build Web, build servidor/Core, build extensión y build Desktop/preload. El resultado de referencia previo al cierre fue de 776 tests: 773 PASS, 3 SKIP y 0 FAIL. Los skips son los existentes y no representan fallos de esta versión.

Las regresiones deterministas cubren ciclos de conexión, cierre tardío de bridges, liberación de tracks y `AudioContext`, Hide/Restore, cleanup correlacionado, carreras Quit/Crash, ausencia de reconexión automática y preservación conservadora de `UNKNOWN` sin retries sensibles.

## Baseline RAM/CPU

Medición visible e inactiva de diez minutos mediante `scripts/desktop-perf-sampler.ps1`:

- 88 muestras.
- 7 procesos identificados.
- Memoria privada total inicial: 244,89 MiB.
- Memoria privada total final: 243,86 MiB.
- Variación: -1,03 MiB.
- CPU promedio en reposo: prácticamente nula.
- Pico transitorio de un proceso auxiliar: posteriormente liberado.
- Intervalo efectivo medio: 6,89 segundos; incluye el trabajo de captura más cinco segundos de espera.

No se observó crecimiento sostenido durante esa ventana. El resultado no prueba ausencia de fugas durante una hora o bajo uso intensivo.

## Riesgos residuales

| Severidad | Riesgo | Tratamiento |
|---|---|---|
| Baja | No se midieron sesiones visible/oculta de una hora. | Mantener como cobertura futura; no bloquea una preview local. |
| Baja | No existe baseline de recursos posterior a carga intensiva. | Reutilizar el sampler si aparece degradación reproducible. |
| Baja | Modo de recuperación del micrófono `NOT_VERIFIED`. | No documentar reconexión manual ni automática hasta obtener evidencia. |
| Baja | Quit posterior a la misma sesión prolongada no se aisló como caso. | Cubrir en una futura campaña de estabilidad si surge evidencia. |
| Informativa | Preview sin instalador, updater, autostart ni wake word. | Empaquetado en V0.6.2; wake word en V0.6.3. |
| Informativa | Browser Control B.2 diferido y Send bloqueado. | No reabrir sin checkpoint y autorización explícitos. |

## Veredicto técnico

**GO para cerrar Atlas V0.6.1 como Desktop Companion local de desarrollo.** Las coberturas parciales quedan documentadas y no constituyen defectos productivos bloqueantes para este alcance. Este veredicto no autoriza distribución pública, no habilita WhatsApp Send y no adelanta funcionalidades de V0.6.2.
