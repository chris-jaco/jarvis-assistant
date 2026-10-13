# ATLAS — Roadmap maestro

**Actualizado:** 13 de octubre de 2026  
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

**Acceptance V0.5.3.6A:** 665 tests: 662 PASS, 3 SKIP, 0 FAIL. Typecheck y builds OK. Commit publicado en rama de desarrollo; no merge a `main` ni tag/release de 6A.

## Roadmap de próximas versiones

| Versión | Nombre | Objetivo | Estado |
|---|---|---|---|
| V0.5.3.6B | WhatsApp Send | Escritura y envío seguro con dos confirmaciones y protección de duplicados | CONDITIONAL GO sólo para B.1/B.2; Send real NO-GO |
| V0.6 | Atlas Core Experience | App Windows con backend local, wake word, publicación, logo, orb-only, logs por voz y costos/modelos | Planificada; arquitectura desktop decidida |
| V0.7 | Productivity Integrations | Notion, Clockify, Instantly, Onabox, HubSpot, Lovable y otras | Alcance por definir |
| V0.8 | Mobile & Headphones Companion | Hablar desde Android/auriculares sin la web delante | Planificada |
| V0.9 — Mark 1 | Proactive Atlas | Briefings, alertas, seguimiento, recordatorios y automatizaciones | Planificada |
| V0.10 | Smart Home & Media | Home Assistant, Spotify y dispositivos | Planificada |
| V0.11 | Always-on Client | Terminal Raspberry Pi, micrófono, altavoz y wake word | Planificada |
| V0.12 | Offline Atlas | STT/TTS, modelo y herramientas locales | Planificada |
| V0.13 | Cloud ↔ Local Router | Selección automática de ejecución/modelos local vs cloud | Planificada |
| Mark 2.0 | Atlas Personal & Collaborative | Reuniones y copiloto Onabox para clientes Flypyme | Visión; alcance futuro |

### V0.5.3.6B — checkpoints
1. **B.1 Contratos y gates:** estados WRITE/SEND, capabilities efímeras, nonce, journal, tests; sin herramientas productivas de escritura/envío.
2. **B.2 Escritura controlada:** `browser.writeDraft`, confirmación independiente, texto exacto en compositor, sin enviar; acceptance real.
3. **B.3 Send simulado:** confirmación, reserva, concurrencia y recuperación UNKNOWN sin efecto externo.
4. **B.4 Send experimental:** sólo tras aprobación, doble gate, capability de un uso y conversación de prueba. Resultado máximo inicial `ACTION_EXECUTED_UNVERIFIED`.
5. **B.5 Release review:** auditoría adversarial, acceptance Windows repetible y decisión explícita de habilitación.

**Restricciones:** `USER_SELECTED` no equivale a `IDENTITY_VERIFIED`. Nunca reintentar automáticamente un envío incierto. No habilitar Send hasta gates y acceptance.

### V0.6 — Atlas Core Experience
**Arquitectura decidida:** aplicación de escritorio Windows con backend local, reutilizando voz, memoria, herramientas, Gmail, Calendar y Chrome Bridge. Chrome sigue siendo una herramienta, no la interfaz obligatoria.

- Desktop app: ventana nativa, instalación, inicio automático, backend local y lifecycle.
- Wake word «Atlas»: detección local, control de micrófono y privacidad.
- Orb-first UI: sólo orbe central por defecto, sin transcript visible; historial, permisos, confirmaciones y errores accesibles cuando haga falta.
- Logo: sustituir por el nuevo diseño cuando se entregue.
- Logs por voz con código: explicación de errores y códigos diagnósticos sanitizados útiles para Codex.
- Routing de modelos/agentes: evaluar modelos según calidad, latencia, compatibilidad y costo. Haiku, Opus, Muse u otros son candidatos, no elecciones cerradas.
- Cost management: costos por sesión/modelo/herramienta, límites y alertas.
- Publicación: instalador Windows, configuración segura, actualización y recuperación de errores.

**Cierre esperado:** uso diario sin pestaña abierta, wake word funcional y conservación de herramientas existentes.

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
- **Pendiente:** nuevo logo, modelos concretos, alcance final de integraciones, backend remoto para móvil, aceptación de Send real.

**Orden:** cerrar B.1–B.5 según gates → V0.6 desktop → V0.7 integraciones → V0.8 móvil → Mark 1 proactivo → hogar/offline/router → Mark 2.
