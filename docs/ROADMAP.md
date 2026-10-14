# ATLAS — Roadmap maestro

**Actualizado:** 14 de octubre de 2026
**Repositorio:** `chris-jaco/jarvis-assistant`  
**Rama de desarrollo actual:** `v0.5.3-consequential-actions`  
**Baseline aceptada V0.5.3.6A:** `168a468b26823df5dcfb5c2a32842463022bc77f`

## Visión
Atlas es un asistente personal de IA, principalmente por voz, con memoria contextual, herramientas, navegación, ejecución autorizada y acceso futuro desde escritorio, móvil y dispositivos domésticos. La visión Mark 2 amplía Atlas a reuniones y un copiloto de campañas para clientes de Flypyme dentro de Onabox.

## Historial de versiones

| Versión | Estado | Implementación | Resultado |
|---|---|---|---|
| V0.1 | Completada | Realtime Voice | WebRTC, VAD, interrupciones, transcripción y sesiones |
| V0.2 | Completada | Universal Tools | Registry, web search, Calendar, OAuth, permisos, confirmaciones y base MCP |
| V0.2.1 | Completada | Calendar & Confirmation | Invitados y correcciones de confirmación por voz |
| V0.2.2 | Completada | Voice & Personality | Perfil de voz y personalidad |
| V0.3 | Completada | Gmail | Integración multicuenta y operaciones de correo |
| V0.3.1 | Completada | Gmail Voice Fix | Corrección de confirmación de envío |
| V0.3.2 | Completada | Unified Confirmation | Confirmación Gmail compartida |
| V0.4 | Completada | Persistent Memory | Memoria contextual persistente |
| V0.4.1 | Completada | Memory Corrections | Entidades y correcciones |
| V0.4.2 | Completada | Memory Reliability | Timeouts |
| V0.4.3 | Completada | Memory & Windows | Preferencias y rendimiento |
| V0.4.4 | Completada | Atlas Identity | Orbe, marca e interfaz voice-first |
| V0.5.0 | Completada | Browser Foundation | Control inicial del navegador |
| V0.5.1 | Completada | Attached Chrome | Extensión MV3 y Native Messaging |
| V0.5.2 | Completada | Browser Authorization | Autorización persistente por origen y grants |
| V0.5.2.1 | Completada | Browser Stabilization | Continuación multietapa y recuperación de contexto |
| V0.5.3.1 | Completada | Consequential Foundation | Intenciones, journal y ejecución simulada |
| V0.5.3.2 | Completada | Safe Draft | Evidencia semántica y borradores privados |
| V0.5.3.2b / .2d | Completada | Compatibility Probes | Investigación read-only de WhatsApp |
| V0.5.3.3 / .3a / .3b | Completada | WhatsApp Adapter | Adaptador y fixes de pestaña/autorización |
| V0.5.3.4 | Completada | Contact Detection | Refinamiento del panel de contacto |
| V0.5.3.5 | NO-GO de identidad automática | Identity Binding | No hay verificación independiente fiable |
| V0.5.3.6A | ACCEPTED | Manual Selection & Private Draft | USER_SELECTED, continuación Realtime, borrador RAM-only, envío bloqueado |
| V0.5.3.6B.1 | Completada | Consequential Contracts & Gates | Capabilities efímeras, journal y autorización de un solo uso; sin Send productivo |
| V0.5.3.6B.2 | PARTIAL / DEFERRED | Controlled Draft Writing | Confirmaciones CONTENT/WRITE alcanzadas; escritura en compositor no verificada y diferida |
| V0.6.0 | Completada | Architecture Readiness | Auditoría completada, Electron elegido y GO condicional por hitos |
| V0.6.1 — Hito 0 | Completada | Architecture Foundation | CoreTransport tipado, transporte web compatible, token Realtime inyectable y ADRs; validación local completa |

**Acceptance V0.5.3.6A:** 665 tests: 662 PASS, 3 SKIP, 0 FAIL. Typecheck y builds OK. Commit publicado en rama de desarrollo; no merge a `main` ni tag/release de 6A.

## Roadmap de próximas versiones

| Versión | Nombre | Objetivo | Estado |
|---|---|---|---|
| V0.5.3.6B | WhatsApp Consequential Actions | Escritura y envío seguro con autorizaciones separadas y protección de duplicados | B.2 PARTIAL / DEFERRED; B.3 y Send bloqueados |
| V0.6 | Atlas Core Experience | App Windows con backend local, wake word, publicación, logo, orb-only, logs por voz y costos/modelos | En curso por hitos; Hito 0 completado localmente |
| V0.7 | Productivity Integrations | Notion, Clockify, Instantly, Onabox, HubSpot, Lovable y otras | Alcance por definir |
| V0.8 | Mobile & Headphones Companion | Hablar desde Android/auriculares sin la web delante | Planificada |
| V0.9 — Mark 1 | Proactive Atlas | Briefings, alertas, seguimiento, recordatorios y automatizaciones | Planificada |
| V0.10 | Smart Home & Media | Home Assistant, Spotify y dispositivos | Planificada |
| V0.11 | Always-on Client | Terminal Raspberry Pi, micrófono, altavoz y wake word | Planificada |
| V0.12 | Offline Atlas | STT/TTS, modelo y herramientas locales | Planificada |
| V0.13 | Cloud ↔ Local Router | Selección automática de ejecución/modelos local vs cloud | Planificada |
| Mark 2.0 | Atlas Personal & Collaborative | Reuniones y copiloto Onabox para clientes Flypyme | Visión; alcance futuro |

### V0.5.3.6B — checkpoints
1. **B.1 Contratos y gates — COMPLETADA:** estados WRITE/SEND, capabilities efímeras, nonce, journal y tests; sin Send productivo.
2. **B.2 Escritura controlada — PARTIAL / DEFERRED:** la arquitectura alcanzó selección manual, confirmación visual CONTENT, `DRAFT_FROZEN`, confirmación visual WRITE e inicio de `WRITE_EXECUTING`. El acceptance real sobre `9a81bcbdd943f2f14071cb320b07b284c063f0dc` terminó con `browser.writeDraft` en `TIMEOUT`, sin `DRAFT_WRITTEN`; el usuario verificó que el compositor permaneció vacío. Atlas además comunicó erróneamente que faltaba un `intentId`, aunque el backend ya había avanzado a WRITE. No hubo envío.
3. **B.3 Send simulado — BLOQUEADA:** no comenzar mientras B.2 siga diferida. La simulación y cualquier ruta de Send permanecen deshabilitadas.
4. **B.4 Send experimental — BLOQUEADA:** requiere aprobación futura posterior a la recuperación y aceptación completa de B.2 y B.3.
5. **B.5 Release review — BLOQUEADA:** depende de una auditoría adversarial y acceptance Windows repetible de los checkpoints anteriores.

**Riesgos pendientes de B.2:** el timeout ocurre después de adquirir autorización WRITE, por lo que debe conservarse la semántica conservadora de ejecución y la prohibición de retry automático; la ausencia de `DRAFT_WRITTEN` impide declarar éxito; el mensaje sobre `intentId` demuestra una divergencia entre el estado estructural del backend y la representación conversacional. Ninguno de estos problemas autoriza una vía alternativa de escritura o envío.

**Punto de recuperación futuro:** retomar desde el límite `WRITE_EXECUTING → browser.writeDraft → DRAFT_WRITTEN`, usando el workflow, capability, journal, confirmaciones CONTENT/WRITE y selección manual ya existentes. Antes de reabrir B.2 habrá que demostrar, en un checkpoint separado, (a) despacho único de la escritura autorizada, (b) resultado verificable del compositor, (c) clasificación honesta de timeout/UNKNOWN sin retry y (d) coherencia entre el estado backend y el mensaje presentado. No se realizarán más hotfixes de WhatsApp durante la transición a V0.6.

**Restricciones:** `USER_SELECTED` no equivale a `IDENTITY_VERIFIED`. Nunca reintentar automáticamente un envío incierto. No habilitar Send hasta gates y acceptance.

### V0.6 — Atlas Core Experience
**Arquitectura decidida:** aplicación de escritorio Windows con backend local, reutilizando voz, memoria, herramientas, Gmail, Calendar y Chrome Bridge. Chrome sigue siendo una herramienta, no la interfaz obligatoria.

**V0.6.0 Architecture Readiness — COMPLETADA:** la auditoría confirmó la reutilización del Core existente, eligió Electron como shell futuro y emitió un GO condicional sujeto a boundaries explícitos, aislamiento del renderer y autenticación del canal local. Las decisiones están registradas en `docs/adr/0060`–`0071`.

- Desktop app: ventana nativa, instalación, inicio automático, backend local y lifecycle.
- Wake word «Atlas»: detección local, control de micrófono y privacidad.
- Orb-first UI: sólo orbe central por defecto, sin transcript visible; historial, permisos, confirmaciones y errores accesibles cuando haga falta.
- Logo: sustituir por el nuevo diseño cuando se entregue.
- Logs por voz con código: explicación de errores y códigos diagnósticos sanitizados útiles para Codex.
- Routing de modelos/agentes: evaluar modelos según calidad, latencia, compatibilidad y costo. Haiku, Opus, Muse u otros son candidatos, no elecciones cerradas.
- Cost management: costos por sesión/modelo/herramienta, límites y alertas.
- Publicación: instalador Windows, configuración segura, actualización y recuperación de errores.

#### Fases propuestas
0. **V0.6.1 — Architecture Foundation:** introducir `CoreTransport` y proveedores inyectables conservando las rutas HTTP, cookies, errores, cancelación, polling, Realtime/WebRTC y comportamiento web existentes. Sin Electron ni cambios funcionales de Browser Control.
1. **Electron vertical slice:** shell mínimo con renderer aislado y backend Node supervisado; health, arranque/cierre y single-instance sin migrar todavía toda la UX.
2. **Desktop lifecycle y canal local:** autenticación del canal, ownership de procesos, recuperación y actualización sin restaurar autoridad operativa.
3. **Confirmaciones y orb-first UX:** permisos, estados RUNNING/WAITING/terminales, confirmaciones y errores accionables con transcript opcional.
4. **Tray, audio y wake word:** tray/autostart opt-in, ownership exclusivo del micrófono, wake word local, barge-in y señalización inequívoca de privacidad.
5. **Browser capability opcional y hardening:** Chrome Bridge como capacidad opcional, empaquetado/updates, observabilidad y regresión completa antes del release candidate.

#### Dependencias y límites
- Preservar Tool Registry, Confirmation Engine, memoria, Chrome Bridge y permisos existentes mediante contratos versionados y tests de regresión.
- Definir primero el proceso propietario del backend, audio y secretos; evitar dos instancias o dos dueños simultáneos del micrófono.
- El wake word requiere una decisión explícita de motor, consumo, distribución y privacidad antes de incorporarlo al instalador.
- Firma de binarios, mecanismo de actualización y almacenamiento seguro de configuración son dependencias de publicación, no detalles posteriores.
- B.2 permanece diferida y B.3/Send bloqueados; V0.6 no debe usar una ruta alternativa para escribir o enviar en WhatsApp.

#### Riesgos principales
- Regresiones de audio/WebRTC al mover el lifecycle desde la web al shell de escritorio.
- Exposición de secretos o contenido sensible en logs, crash reports, actualizaciones o almacenamiento local.
- Conflictos entre autostart, single-instance, Native Host y procesos backend huérfanos.
- Falsos positivos del wake word, micrófono activo sin señalización clara y consumo sostenido de recursos.
- Acoplamiento prematuro a un framework desktop o proveedor/modelo sin métricas comparables.

#### Criterios de aceptación
- Instalación y actualización reproducibles en Windows, con desinstalación limpia y recuperación documentada.
- Inicio único del backend local y estado de conexión observable; reinicios no duplican procesos ni autorizaciones.
- Wake word y activación manual funcionan con indicación inequívoca del micrófono; privacidad validada offline/online.
- Una sesión diaria puede operar sin mantener una pestaña de Atlas abierta, conservando barge-in y respuestas audibles.
- Gmail, Calendar, memoria y Browser Control pasan sus regresiones y conservan confirmaciones, grants y semántica `EXECUTION_UNKNOWN`.
- Diagnósticos y métricas no contienen prompts, credenciales ni contenido privado; costos y latencia pueden auditarse por sesión.
- WhatsApp Send continúa imposible y B.2 no se presenta como completada.

**Cierre esperado:** uso diario sin pestaña abierta, wake word funcional, herramientas existentes sin regresiones y distribución Windows recuperable.

### V0.7 — Productivity Integrations
Plataformas candidatas, **sin alcance cerrado**:
- **Alta:** Notion (proyectos/tareas/sprints), Clockify (tiempo), Instantly (campañas/leads), Onabox (prospectos/scoring/campañas), HubSpot (CRM).
- **Media:** Lovable (proyectos/builds).
- Otras según API/MCP y utilidad.

Madurez por integración: READ → WRITE con confirmación → workflows compuestos. Reutilizar Tool Registry y Confirmation Engine.

### V0.8 — Mobile & Headphones
Cliente Android, audio Bluetooth, continuidad de contexto, memoria y herramientas, autenticación y conexión con backend. Pendiente decidir disponibilidad cuando el PC esté apagado (backend remoto/híbrido). Validar límites de Android para wake word y micrófono en background. Las acciones en Chrome Windows dependen de que el host esté conectado/autorizado.

### V0.9 — Proactive Atlas / Mark 1
Briefings, revisiones de correo/calendario, seguimiento de compromisos, alertas, recordatorios y automatizaciones; relevancia, frecuencia, privacidad y confirmaciones para acciones externas.

### V0.10 — Smart Home & Media
Home Assistant, Spotify, luces, escenas, música y dispositivos; permisos según sensibilidad.

### V0.11 — Always-on Client
Raspberry Pi o terminal dedicado, micrófono, altavoz, wake word y conexión a la misma plataforma Atlas.

### V0.12 — Offline Atlas
STT/TTS/modelo local y herramientas locales permitidas; declarar explícitamente cuándo una operación necesita Internet.

### V0.13 — Cloud ↔ Local Router
Routing según complejidad, privacidad, latencia, costo y conectividad, aprovechando medición de V0.6 y ejecución offline de V0.12.

## Mark 2.0 — líneas estratégicas futuras

**Atlas Meetings:** incorporarse a reuniones autorizadas, transcribir, resumir, extraer decisiones y compromisos y, eventualmente, participar con permiso. Dimensionar consentimiento, participantes, grabación, privacidad y retención.

**Atlas for Onabox / Flypyme:** copiloto para clientes en creación autónoma de campañas: ICP, segmentación, mensajes, configuración, análisis y optimización. Requiere multiusuario/multitenant, aislamiento de datos, permisos por organización y controles antes de publicar o ejecutar campañas.

Estas capacidades no tienen versión detallada ni compromiso de implementación todavía.

## Principios y decisiones
- Voice-first, con interfaz visual cuando aporte claridad y seguridad.
- Plataforma unificada; clientes desktop, móvil y hogar reutilizan herramientas y memoria.
- Confirmación, autorización y revalidación para efectos sensibles.
- Memoria persistente con privacidad.
- Costos y latencia medibles antes de añadir complejidad multiagente.
- Checkpoints pequeños, tests, acceptance real y commits separados; preservar regresiones.
- **Definido:** Windows desktop con backend local; wake word; orb-first; diagnósticos por voz; medición de costos.
- **Pendiente:** nuevo logo, modelos concretos, alcance final de integraciones, backend remoto para móvil y recuperación futura de B.2. Send real continúa bloqueado.

**Orden vigente:** cerrar documentalmente B.2 como PARTIAL / DEFERRED y mantener B.3–B.5 bloqueadas → V0.6 desktop por fases → V0.7 integraciones → V0.8 móvil → Mark 1 proactivo → hogar/offline/router → Mark 2. La reapertura de B.2 requerirá una decisión explícita posterior.
