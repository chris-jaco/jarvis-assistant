# JARVIS V0.2.1 — Universal Tool Foundation

Asistente personal por voz: TypeScript strict, Node HTTP nativo, UI mínima sin framework, OpenAI Realtime y WebRTC. V0.2 añade herramientas sin reemplazar la arquitectura V0.1. El tag `v0.1.0` es la referencia conocida y no se modifica. V0.3 se desarrolla en `v0.3-gmail`, sobre el tag `v0.2.2`; no se publica ni mezcla automáticamente en `main`.

## Instalar y ejecutar

Node >=22.12 (validado con Node 24.19.0), npm y navegador Chrome/Edge con micrófono. Usa localhost o HTTPS. Auriculares recomendados.

```bash
npm ci
# Solo si todavía no tienes .env:
cp .env.example .env
npm run dev
```

Abre `http://localhost:3000` en tu máquina local. Configura `OPENAI_API_KEY` exclusivamente en el backend `.env` o entorno del proceso. Necesitas acceso/billing para el modelo Realtime y el modelo de búsqueda. Nunca uses `VITE_` para secretos. Calendar es opcional: no exige credenciales para iniciar el servidor, conversar o buscar información. La búsqueda usa la misma clave de OpenAI; sin ella falla claramente.

```bash
npm run typecheck
npm test
npm run build
npm start
```

No hay lint configurado. El lockfile fija dependencias. `npm start` sirve `dist/client` y el backend compilado. Reinicia tras cambiar configuración. Los tests no requieren cuentas externas.

## Configuración

| Variable | Uso |
| --- | --- |
| `OPENAI_API_KEY` | Clave privada del backend para token efímero y Responses. |
| `PORT`, `HOST` | 3000 y 127.0.0.1 por defecto; puerto válido y host de escucha. |
| `USER_TIMEZONE` | Zona IANA explícita, ejemplo Europe/Madrid; se valida al iniciar. |
| `OPENAI_SEARCH_MODEL` | Modelo Responses con web_search; gpt-4.1 por defecto, configurable. |
| `TOOL_CONFIRM_WRITES` | true por defecto; false permite WRITE sin confirmación. SENSITIVE siempre confirma. Las invitaciones y actualizaciones a asistentes exigen confirmación explícita aunque TOOL_CONFIRM_WRITES=false; confirmWhen permite a un adapter exigirla según la mutación ya preparada. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Cliente OAuth privado del backend; opcionales. |
| `GOOGLE_REDIRECT_URI` | Callback local http://127.0.0.1:3001/oauth/callback. |
| `GOOGLE_CALENDAR_ID` | primary por defecto; selecciona un calendario que puedas gestionar. |
| `GOOGLE_TOKEN_PATH` | .local/google-tokens.json por defecto; archivo privado ignorado por Git. |

`.env.example` contiene únicamente placeholders y valores públicos. No pongas claves, tokens ni archivos OAuth en Git. Si cambias tokenPath usa un directorio privado fuera del checkout o añade su ruta a `.gitignore`; no apuntes a un archivo fuente ni una carpeta servida al navegador. En cloud configura el acceso saliente a api.openai.com, www.googleapis.com, oauth2.googleapis.com y accounts.google.com según la operación. No instales clientes VPN adicionales. Los secretos proxy bajo el nombre reservado OPENAI_API_KEY no se pueden declarar con la herramienta de onboarding; configura esa clave mediante el mecanismo seguro disponible para el backend, nunca en chat.

## Arquitectura

```text
RealtimeAgent / RealtimeSession (navegador, WebRTC V0.1)
   → Function tools SDK: puente HTTP mínimo
   → Sesión backend (cookie opaca HttpOnly / SameSite=Strict)
   → Tool Registry → validación → preparación → permisos
   → confirmación pendiente si procede → adapter.execute
   → resultado normalizado + telemetría → agente por voz
```

- `src/core/`: contrato de provider y personalidad/configuración de voz centralizada.
- `src/provider/openai.ts`: mismo WebRTC, token efímero, semantic VAD, estados, transcript y limpieza del micrófono; añade el puente de herramientas.
- `src/provider/tools.ts`: funciones SDK, confirmaciones de voz y botones, actividad. No contiene credenciales.
- `src/server/tools.ts`: sesiones locales, endpoints, límites y composición de integraciones.
- `src/tools/registry.ts`, `types.ts`: registro y contrato de herramientas/adapters.
- `src/tools/permissions.ts`, `execution.ts`: ruta central obligatoria de seguridad/ejecución.
- `src/tools/telemetry.ts`: últimas 100 actividades en memoria por sesión.
- `src/tools/adapters/`: web search, Calendar REST/OAuth, tiempo y base MCP.

El registro normaliza id, nombre, descripción, integración, capacidad, permiso, schema Zod, handler y timeout. Rechaza IDs duplicados. Un `ToolAdapter` declara integración, transporte (`hosted`, `mcp`, `api`, `function`, `local`), herramientas y cierre opcional. El core no conoce credenciales ni detalles del transporte. El browser recibe solo descriptores públicos; cada función SDK acepta inputJson, cuyo objeto se valida estrictamente en el servidor contra el schema publicado. Registrar un adapter en la composición publica sus herramientas sin tocar la UI ni el provider.

## Permisos y confirmación

READ no confirma. WRITE confirma por defecto y se configura por herramienta (`confirm`) o mediante TOOL_CONFIRM_WRITES para Calendar. SENSITIVE siempre confirma, aunque confirm sea false.

La preparación de una mutación resuelve el evento y su versión sin cambiar estado externo. Guarda un snapshot privado con ID/etag, argumentos, resumen visible, identificador aleatorio y expiración de 60 segundos. Solo existe una confirmación pendiente por sesión. El backend consume el identificador antes de cualquier await; decisiones repetidas/concurrentes no ejecutan dos veces. Caducar, rechazar, desconectar, cerrar sesión, iniciar otra herramienta o cambiar la solicitud invalida la confirmación. Las sesiones duran 30 minutos y admiten 100 invocaciones como máximo; reconecta después del límite. Una sesión por navegador; una nueva conexión invalida la anterior.

El tool devuelve pending y JARVIS debe leer la pregunta summary y esperar. Después de terminar esa pregunta, di «Sí», «Sí, confirma», «Confirmar», «Adelante», «Hazlo», «Sí, hazlo», «Sí, confirmo» o «Confirmo»; «No», «Cancela», «Cancelar» o «No lo hagas» rechaza. Solo se acepta aprobación de un nuevo item de voz iniciado después del output_audio_buffer.stopped de la respuesta nueva vinculada a la acción pendiente (response.created; no necesita un started correspondiente); cleared/interrupción no arma aprobación. La generación response.done no equivale al fin de reproducción. Realtime puede pedir otra herramienta antes de llegar la transcripción final del «Sí»: mientras haya confirmación pendiente el puente devuelve la acción congelada y bloquea la nueva ejecución, sin reemplazarla ni borrar su captura de voz. La captura conserva el ID pendiente y si el turno empezó tras la pregunta; una transcripción antigua no puede aprobar. Espera a terminar la pregunta para confirmar por voz. Un «Sí» anticipado se ignora sin ejecutar ni cancelar por cambio de solicitud; «No» puede rechazar incluso antes del final. Una frase distinta cancela la solicitud en vez de interpretarla mediante otro LLM. También puedes usar Confirmar/Cancelar en la UI. Si una transcripción falla, usa los botones o deja caducar la solicitud. Nunca hay un tool que permita al modelo otorgarse aprobación.

El SDK 0.18.0 ofrece `needsApproval`, `tool_approval_requested`, `session.approve` y `session.reject`, pero la guía Realtime indica que el agente no procesa nuevos pedidos mientras espera aprobación nativa. V0.2 usa la pequeña capa backend para permitir el siguiente turno de voz y mantener autoridad/estado del lado servidor. No se usa sticky approval ni aprobación por nombre de herramienta. La voz usa transcripción, no autenticación biométrica: acepta solo un entorno local y supervisado. Si no se oye la pregunta completa, se interrumpe o la respuesta no se reconoce, usa los botones para revisar el resumen exacto.

Las mutaciones usan If-Match con el etag preparado: si cambia el evento, fallan con CONFLICT y requieren nueva consulta/confirmación. Se genera un ID de evento antes de crear. Duplicados con el mismo call ID comparten resultado. No hay retries automáticos de escrituras. Un timeout después de enviar una escritura puede dejar un resultado incierto: consulta Calendar antes de repetir. La protección de replay no es una garantía transaccional de exactly-once en servicios externos.

## Búsqueda actual

`web.search` es READ. El puente Realtime llama al adapter backend, que hace una sola petición Responses con `web_search` GA (no web_search_preview), `store:false`, búsqueda obligatoria, máximo dos llamadas hosted y salida breve. Timeout 25 s. Devuelve respuesta, citas HTTPS cuando disponibles y momento de consulta. Si el proveedor no completa una búsqueda o devuelve error, no se entrega una respuesta inventada. No se exponen bodies de error upstream.

Realtime no recibe directamente un hosted web search: mantiene su arquitectura de voz y recibe un resultado de función. No se crea otro bucle agentic innecesario. Las fuentes externas son datos no fiables, nunca instrucciones. La respuesta de búsqueda requiere además la síntesis de voz de Realtime.

## Google Calendar y OAuth local

Se usa la API oficial Google Calendar v3 y google-auth-library. Evita depender de un servidor MCP adicional y permite controlar OAuth, rangos, etags y permisos directamente. MCP sigue disponible para integraciones futuras que lo justifiquen.

Herramientas:

| ID | Permiso | Comportamiento |
| --- | --- | --- |
| calendar.listEvents | READ | Próximos eventos o rango explícito; incluye eventos de día completo. |
| calendar.getEvent | READ | Detalles por ID o búsqueda con rango. |
| calendar.availability | READ | freeBusy, unión de intervalos ocupados y huecos libres. |
| calendar.createEvent | WRITE | Evento con título, comienzo y fin explícitos. |
| calendar.updateEvent | WRITE | Renombrar/mover un evento con horario completo. |
| calendar.deleteEvent | SENSITIVE | Eliminar una ocurrencia/evento tras confirmación obligatoria. |

Fechas locales se convierten con Temporal en USER_TIMEZONE; offsets explícitos representan instantes. Se rechazan horas inexistentes/ambiguas en cambios DST y rangos invertidos. El agente recibe timezone y reloj al conectar. Para «mañana», construye desde el calendario local, no sumando siempre 24 h. Si falta duración, JARVIS pregunta. Un nombre requiere rango de búsqueda; varias coincidencias producen AMBIGUOUS y no mutan nada. Puede listar el rango y pedir al usuario escoger un ID. No se eligen silenciosamente eventos. Máximo 100 resultados; listas truncadas fallan explícitamente. No se gestionan series completas ni movimientos de eventos de día completo. Crear/actualizar reuniones con asistentes usa sendUpdates=all solo después de aprobación; las mutaciones sin asistentes y eliminación conservan sendUpdates=none; prueba inicialmente con un calendario privado de pruebas.

Autorización inicial, en tu máquina local:

1. Crea/selecciona un proyecto en Google Cloud y habilita Google Calendar API.
2. Configura Google Auth Platform / pantalla de consentimiento. Para app personal externa en testing añade tu cuenta como test user. Los refresh tokens en testing pueden expirar en 7 días; vuelve a autorizar si procede.
3. Crea un cliente OAuth tipo **Web application** con redirect URI exacta `http://127.0.0.1:3001/oauth/callback`. La app y callback son servicios locales, no un login frontend público.
4. Introduce client ID y client secret en `.env` backend. Selecciona USER_TIMEZONE y GOOGLE_CALENDAR_ID. No compartas el archivo ni valores en chat.
5. Ejecuta `npm run google:authorize`. Abre la URL indicada en un navegador **de la misma máquina** y concede los scopes calendar.events y calendar.freebusy. El callback escucha solo en loopback y se cierra al finalizar o después de 5 minutos.
6. Reinicia JARVIS. No copies tokens al browser. El archivo `.local/google-tokens.json` contiene refresh/access tokens, se reemplaza atómicamente. En Linux/macOS conserva archivo 0600 y carpeta 0700 y exige propietario actual sin acceso de grupo/otros. En Windows usa ACL nativa: crea una carpeta privada con herencia desactivada para el usuario actual y SYSTEM, y verifica propietario y todas las reglas Allow del archivo/carpeta (solo usuario, SYSTEM o Administrators). No interpreta chmod como una ACL Windows. `.local/` está ignorado por Git. El código rechaza archivos no regulares, hard links, symlinks y carpetas inseguras antes de leer/escribir; en Windows también comprueba reparse points en el recorrido del path. Verifica la seguridad del temporal vacío antes de escribir tokens y lo elimina si falla. Windows requiere Windows PowerShell integrado y un filesystem con ACL (por ejemplo NTFS); si no puede verificar la seguridad falla cerrado como UNCONFIGURED, sin fallback a permisos simulados. Para una carpeta existente insegura no cambia permisos silenciosamente: utiliza una nueva carpeta de credenciales dedicada (por ejemplo GOOGLE_TOKEN_PATH=.local/oauth/google-tokens.json), autoriza de nuevo y retira de forma segura el archivo antiguo. Evita OneDrive/junctions o unidades FAT para este almacenamiento; una ruta privada fuera del checkout también sirve. Nunca guardes tokens en rutas versionadas. google-auth-library refresca access tokens y el backend persiste tokens renovados conservando refresh_token.
7. Para revocar, retira acceso en tu cuenta Google y elimina el token file privado. No registres su contenido. Si faltan credenciales, archivo o autorización, Calendar devuelve UNCONFIGURED sin impedir conversación/búsqueda.

El callback valida state aleatorio, consume una sola respuesta y usa PKCE S256. El OAuth completo necesita tu cuenta; no fue ejecutado con credenciales reales en cloud. Un callback de loopback requiere tu navegador local, no simplemente abrirlo desde una máquina distinta.


### Asistentes e invitaciones (V0.2.1)

Create acepta `attendees: ["sofia@example.com", "juan@example.com"]`: trim, minúsculas, validación de email, máximo 50 y deduplicación. Update permite cambios solo de asistentes sin mover horario, además de título/horario; si mueve debe enviar inicio y fin juntos. `attendeeMode: "add"` es el default y conserva asistentes existentes y RSVP; `"replace"`/`"remove"` requieren una solicitud explícita. replace con [] retira todos; remove retira los emails indicados. El cuerpo preparado y el resumen incluyen destinatarios finales y cambios antes de confirmar, y conservan ID/etag. Preparación solo lee, nunca invita. Un evento cambiado después de preparar falla If-Match sin retry automático. Una lista parcial de asistentes falla cerrada.

Mover/renombrar una reunión con asistentes también requiere aprobación para sus actualizaciones externas. Actualizaciones que no cambian asistentes omiten el campo del PATCH para conservarlos. Calendar detalles devuelve emails para revisión; no se añaden a telemetría. Un nombre como «Sofía» no resuelve un contacto: JARVIS debe pedir email explícito, nunca adivinarlo. Un adapter de contactos futuro podría proporcionar esos mismos emails validados; no está implementado. La entrega de correo depende de Google y preferencias del destinatario, no está garantizada por una respuesta HTTP exitosa. Eliminación conserva su política previa de notificaciones.

Aceptación local adicional: crea una reunión privada de prueba con tu email de pruebas, rechaza y comprueba que no existe ni invita; repite y confirma con «Sí, confirma» tras el final de la pregunta. Comprueba un solo evento y una invitación tras aprobación. Añade un segundo email con update sin cambiar la hora, comprueba que mantiene el primero y sus RSVP, y verifica «No lo hagas». Un nombre sin email debe generar una pregunta, no invitación. Prueba todos los afirmativos, frase ambigua, expiración de 60 s, cambio de solicitud, botones y barge-in. No uses destinatarios de terceros sin su consentimiento para tus pruebas.

## Perfil de voz V0.2.2 (para aceptación local)

La voz Realtime pasa de `marin` a `cedar`. Toda la configuración sigue en
`src/core/personality.ts`: `JARVIS_VOICE`, `JARVIS_SPEAKING_STYLE` y el bloque
validado `JARVIS_TOOL_INSTRUCTIONS` forman las instrucciones del agente. Se
mantienen `gpt-realtime-2.1`, WebRTC, VAD semántico `medium`, interrupciones y el
flujo de confirmación V0.2.1.

El perfil pide una voz masculina con español nativo, acento rioplatense/argentino
ligero y voseo natural; adapta el idioma si Christian cambia de idioma o lo pide.
La entrega es directa, tranquila y amable: respuesta primero, normalmente una o
dos frases, sin muletillas repetidas ni narración de pasos obvios. Confirmaciones y
resultados simples son concisos, pero conservan los datos necesarios para aprobar
la acción, las aclaraciones y la información de seguridad. No se añade ninguna
espera ni se cambian parámetros de red, generación o transcripción.

El acento, el timbre percibido y el ritmo se orientan mediante instrucciones;
no existe aquí un selector independiente de acento argentino. La pronunciación y
el voseo pueden variar entre respuestas y requieren escucha real. Las pruebas
verifican configuración e instrucciones, no la calidad acústica.

Aceptación local: reconecta para abrir una sesión nueva con `cedar`; probá
«Hola Jarvis, ¿me escuchás?», una pregunta sencilla, una explicación larga pedida
explícitamente y un cambio de idioma. Después probá crear y cancelar una reunión
de prueba, confirmar con «Sí, confirmo» tras terminar la pregunta, rechazar con
«No» e interrumpir una respuesta. Comprobá el acento sin exageración, respuestas
breves y todas las protecciones V0.2.1. Este es el perfil validado de V0.2.2.

## MCP y futuras integraciones

`src/tools/adapters/mcp.ts` acepta el contrato oficial `MCPServer` de @openai/agents-core 0.18.0. Usa `MCPServerStreamableHttp` para servidores remotos nuevos o `MCPServerStdio` para procesos locales. No uses SSE legado para nuevas integraciones. No se conecta ningún servidor de demostración ni servidor de terceros por defecto.

Para añadir una integración REST/API (Clockify u Onabox):

1. Implementa ToolAdapter en `src/tools/adapters/`, con credenciales solo en el constructor backend.
2. Declara IDs únicos, schema Zod estricto, capacidad y READ/WRITE/SENSITIVE para cada operación. Los cambios son WRITE; acciones destructivas o externamente consecuentes son SENSITIVE.
3. Implementa prepare/summarize para resolver ambigüedades y congelar argumentos antes de aprobar. Execute debe propagar AbortSignal, permitir reconciliación y devolver solo datos necesarios. No hagas mutaciones en prepare.
4. Regístralo en createToolRuntime. Añade placeholders en .env.example y tests con mocks. La UI/voz publica automáticamente el descriptor. Nunca llames al adapter saltándote ToolExecutor.

Para añadir MCP (por ejemplo Notion, si un servidor mantenido es adecuado):

1. Crea/connecta `MCPServerStreamableHttp` exclusivamente en backend, con endpoint fijo revisado y headers privados. No aceptes URLs arbitrarias del modelo/browser.
2. Pasa el servidor a mcpAdapter con allowlist explícita de remoteName, IDs locales, schemas Zod revisados, permisos y `project(result)` que filtre credenciales/datos innecesarios. No confíes en anotaciones READ del servidor para autorizar mutaciones.
3. Registra el adapter y llama a close al apagar; gestiona reconexión/token OAuth del servicio en backend. Si cambian tools remotos, revisa de nuevo antes de ampliar la allowlist.
4. Prueba errores, timeouts, permisos, ambigüedad y filtrado de resultados. Para futuras mutaciones MCP implementa preparación/confirmación revisada; no expongas handlers directos.

Hosted tools futuros pueden usar Responses/SDK en un adapter backend como web.search. Hosted MCP del SDK existe, pero configurarlo directamente en el navegador permitiría ejecución fuera de este executor; no se usa aquí. Todo nuevo transporte debe pasar por el mismo modelo de permisos y telemetría.

Ejemplos futuros **no implementados**: Clockify REST o MCP fiable; Notion MCP si adecuado; Onabox REST custom; Home Assistant API local o MCP. Tampoco Gmail, HubSpot, Spotify, Drive, n8n, memoria persistente, fallback LLM local, Raspberry Pi, wake word, móvil, jobs autónomos, pagos ni computer control.

## Telemetría, errores y latencia

Cada actividad guarda toolId, integración, permiso, start/end, duración total (incluye espera de aprobación), estado, si requiere confirmación, decisión y categoría segura de error. Últimas 100 entradas en memoria de la sesión; ningún argumento, título/evento privado, token, clave ni resultado completo. La UI muestra actividad y confirmación pendiente. ToolTelemetry puede sustituirse por un sink persistente en una versión futura.

Timeouts por tool, abort de transportes, schema estricto, máximo 16 KiB por petición HTTP, una ejecución HTTP activa por sesión, máximo 10 sesiones y 100 calls/sesión. Las categorías INVALID_INPUT, UNCONFIGURED, UPSTREAM, TIMEOUT, AMBIGUOUS, CONFLICT, EXPIRED, REJECTED y LIMIT tienen mensajes seguros. No se registran errores upstream crudos.

No hay medidas reales de latencia OpenAI/Google en cloud sin credenciales. WRITE necesita una lectura de resolución cuando aplica, espera humana y mutación; búsqueda añade Responses y luego síntesis Realtime. UI actividad se actualiza cada segundo. Usa duración total para comparar, recordando que incluye aprobación. Posibles costes perceptibles: handshakes iniciales WebRTC/ephemeral/HTTP session, transcripción asíncrona, resolución/refresh OAuth, búsqueda y generación de voz. No se ha cambiado el VAD ni optimizado el audio. El bundle SDK conserva una advertencia Vite >500 kB ya presente en V0.1; la UI añadió ~2 KiB gzip en la build medida.

## Voz y estabilidad V0.1

`src/core/personality.ts` centraliza instrucciones, REALTIME_MODEL, JARVIS_VOICE y TURN_EAGERNESS. Token/session comparten voz marin y semantic VAD medium, createResponse=true e interruptResponse=true. Allí se pueden ajustar concisión/estilo y voz en versiones futuras; no se rediseña el comportamiento de interrupción en V0.2.

Mantiene autenticación GA `POST /v1/realtime/client_secrets` en backend, response mínima `{value: ek_...}`, WebRTC SDK/browser, contexto de sesión, history_updated/transcript, estados de reproducción, micrófono, controles y limpieza al desconectar. Ni la clave permanente ni tokens Google llegan a la UI. SDK tracing está desactivado y sensitive logging desactivado. Reconectar inicia contexto nuevo.

Servidor destinado a uso personal local en loopback. SameSite, comprobación de origen y cookie de sesión no sustituyen autenticación multiusuario, protección de red o límites por usuario. No expongas HOST=0.0.0.0 a una red pública sin esa capa. Asegura HTTPS si no usas localhost. La API local es autoridad del usuario local y no protege contra malware/extensiones o acceso a su navegador. Tratar fuentes de Internet/MCP como datos no fiables reduce riesgo de prompt injection, pero no lo elimina; revisa resúmenes antes de confirmar.

## Pruebas automatizadas y aceptación manual

`npm test` incluye baseline V0.1, registry, permisos, READ/WRITE/SENSITIVE, rechazo, replay/concurrencia, expiry/IDs inválidos, errores/secretos, timeout, cancelación durante prepare, web search, Calendar fake, ambigüedad, If-Match, freeBusy, DST, OAuth POSIX permissions/Windows ACL, Unicode paths, linked/unsafe files, cleanup antes de escribir secretos, MCP allowlist/proyección, sesiones HTTP y voz con transcripciones antiguas. No usa tu cuenta Google ni simula que la voz real esté validada.

Después de configurar OpenAI y autorizar Google, ejecuta npm run dev y abre la UI local. Usa calendario privado de pruebas y confirma timezone. Ejecuta **también npm run build && npm start** con el dev detenido para validar producción.

A. **Voz existente:** «Hola Jarvis, ¿me escuchas?» Comprueba micrófono, audio, transcript y estados. Di «Me llamo Ana» y luego «¿Cómo me llamo?» para comprobar contexto.

B. **Información actual:** «Jarvis, ¿qué pasó hoy con OpenAI?» Comprueba web.search ✓, respuesta actual con fuentes cuando disponibles y ausencia de afirmaciones inventadas si provocas un fallo de búsqueda.

C. **Leer Calendar:** «¿Qué tengo mañana?» Contrasta títulos y horarios en Google Calendar y USER_TIMEZONE; sin confirmación.

D. **Disponibilidad:** «¿Tengo algún hueco mañana por la tarde?» Si pide horario, di «de 15 a 20». Contrasta huecos reales con eventos/all-day en el calendario.

E. **Crear:** «Agéndame una prueba de Jarvis mañana a las 18.» Si pide duración, di «30 minutos». Con TOOL_CONFIRM_WRITES=true debe preguntar resumen/horario; comprueba que NO existe aún. Espera el final de la pregunta y di «Sí». Debe aparecer un solo evento 18:00–18:30. Con false debe ejecutar sin confirmación de WRITE.

F. **Modificar:** «Mueve la prueba de Jarvis a las 18:30.» Si pregunta duración, di «mantén los 30 minutos». Confirma si true; verifica 18:30–19:00 y que no hay duplicado. Si hay dos pruebas, debe pedir cuál sin mover ninguna.

G. **Eliminar:** «Elimina la prueba de Jarvis.» Debe pedir fecha si falta o buscar en rango explícito acordado. JARVIS **debe preguntar confirmación explícita con evento/fecha** incluso con TOOL_CONFIRM_WRITES=false. Antes de «Sí» comprueba que sigue existiendo. Después de confirmación, verifica eliminación. Un segundo «Sí» no debe ejecutar otra eliminación.

H. **Rechazar:** Crea otra prueba; pide borrarla y, tras la pregunta, di «No». Verifica que sigue en Calendar. Repite y espera más de 60 s antes de «Sí»; debe caducar sin borrar. Repite con solicitud distinta seguida de «Sí»: ninguna acción anterior debe ejecutarse.

I. **Interrumpir:** Pide una explicación larga e interrumpe hablando «Para, responde en una frase». Comprueba que se corta reproducción y responde al nuevo turno. Prueba también Interrumpir. Desconecta/reconecta y verifica limpieza del micrófono y contexto nuevo.

Extra: deniega micrófono y reconecta tras concederlo; desconecta durante connecting/speaking; corta red; inspecciona Network/assets para confirmar que no aparece clave permanente ni Google tokens. Sin Calendar, debe responder error claro de integración y seguir conversando/buscando. Si la voz «Sí» no se reconoce, verifica fallback de botones y no ejecución accidental.

## Fuentes oficiales revisadas

Consulta del 3 octubre 2026; versiones instaladas @openai/agents-realtime y @openai/agents-core 0.18.0. Se revisaron también los tipos y ejecución del paquete instalado; no se actualizó el SDK Realtime del baseline.

- [Agents SDK JS/TS quickstart Realtime](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/).
- [Realtime function tools, hosted MCP, HITL y limitación de voz durante aprobación](https://openai.github.io/openai-agents-js/guides/voice-agents/build/).
- [Tools y web_search hosted](https://openai.github.io/openai-agents-js/guides/tools/).
- [MCP oficial: Streamable HTTP/stdio y hosted](https://openai.github.io/openai-agents-js/guides/mcp/).
- [HITL y autoridad de aprobación server-side](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/).
- [Fuentes actuales oficiales OpenAI](https://github.com/openai/openai-agents-js/tree/main/docs/src/content/docs/guides) y [ejemplo hosted tools](https://github.com/openai/openai-agents-js/blob/main/examples/docs/tools/hostedTools.ts).
- [Web search API](https://developers.openai.com/api/docs/guides/tools-web-search/): acceso directo bloqueado por proxy 403; se consultaron guía/source oficiales del SDK anteriores, que especifican web_search GA.
- [Google Calendar API oficial discovery](https://github.com/googleapis/google-api-nodejs-client/blob/main/discovery/calendar-v3.json) para events/freeBusy/scopes/parámetros y [google-auth-library oficial OAuth](https://github.com/googleapis/google-auth-library-nodejs#oauth2). Sitios developers.google.com bloqueados por proxy; estas fuentes oficiales fueron accesibles.

Las pruebas cloud validan entorno/código y HTTP. No establecen llamadas reales a OpenAI/Google ni micrófono, audio, semantic VAD o barge-in: completa el plan manual para validar esos comportamientos con tus credenciales y navegador.

### Collecting a safe live confirmation trace (development only)

The live Windows trace established that post-tool confirmation responses can finish
playback without a matching `output_audio_buffer.started` for that response. The
buffer had already started for the preceding tool-calling response. The bridge now
binds the first fresh post-tool `response.created` to the frozen confirmation and
arms only on that response's `output_audio_buffer.stopped`. `response.done` alone
does not arm. Previously observed response IDs cannot arm a new action.

Speech eligibility is frozen at `speech_started`: an early/stale affirmative never
executes, even if its transcript arrives after playback ends. It is ignored rather
than misclassified as a request change. An interrupted/failed prompt remains
ineligible; use a newly prepared action or the explicit UI decision in that case.
A completed prompt cannot be replaced/disarmed by later acknowledgments or
repeated tool calls. Unrelated speech cancels; negative speech rejects. Backend
cancellation feedback identifies the cancelled action and explicitly releases the
model to prepare the corrected request immediately.

In Windows PowerShell, from the repository directory, run:

```powershell
npm install
$env:JARVIS_CONFIRMATION_TRACE = "true"
npm run dev
```

On Linux/macOS use `JARVIS_CONFIRMATION_TRACE=true npm run dev`.
Open the browser developer tools **Console**, enable **Preserve log**, filter for
`[JARVIS confirmation]`, and connect/reconnect JARVIS. Reproduce the correction
followed by a new confirmation prompt and **“Sí, confirmo.”** once. Copy the
filtered console lines from `bridge.initialize` through the cancellation or
decision, plus terminal lines with the same prefix. Return those lines and the
browser/version and OS; do not copy the normal conversation transcript, network
payloads, `.env`, or OAuth files. Console entries are JSON strings so copying
lines preserves their event order and original snapshots.

The trace records only allowlisted event types/reasons, opaque identifier hashes,
armed state, capture eligibility and affirmative/negative/unrelated classification.
It includes raw transport arrival order for playback, speech, transcript, response
and function-call events; bridge transitions, blocked repeated tools, `/cancel`
and `/decision`; and server executor preparation/invalidation/decision/close.
Identifiers are correlation hints, not authentication values; hashes may collide.
No transcript text, audio, tool arguments/results, attendee details, credentials,
cookies or tokens are logged. No diagnostic trace is persisted by JARVIS.

Tracing defaults off and requires both explicit opt-in and the development server.
`npm start` never enables it, even if the environment variable is true. Stop the
server, then disable it with `Remove-Item Env:JARVIS_CONFIRMATION_TRACE` in
PowerShell (or `unset JARVIS_CONFIRMATION_TRACE` on Linux/macOS), and restart.
If enabled in `.env`, change that entry to `false` instead.

The regression replays the supplied live order: prior response audio start, frozen
action preparation, a fresh prompt response/items/generation completion, playback
stop without a matching start, new speech, an intermediate acknowledgment response,
and final affirmative transcript. It verifies one decision, one mutation, no
cancel and no REJECTED telemetry. Separate tests cover corrections followed by new
confirmations, pre-prompt speech, interruption, stale playback IDs, failures,
acknowledgments and repeated calls. Diagnostics remain available for local retests.
Automatic Realtime turn responses remain enabled to preserve V0.1 voice behavior;
the model may still produce a short acknowledgment before the backend result.
That acknowledgment cannot approve or replace the frozen action.

## Gmail V0.3 — varias cuentas y adjuntos

Gmail se registra en el mismo `ToolRegistry` y pasa por `ToolExecutor`, las
permisiones, la confirmación y la telemetría existentes. No hay otro ejecutor ni
un endpoint que permita enviar sin aprobación. `cedar`, el perfil V0.2.2 y la
máquina de confirmación por voz permanecen sin cambios.

### Cuentas, identidades y OAuth

Cada cuenta se identifica por `g_` + un hash del `sub` verificado de Google. El ID
permanece estable si cambia el correo. Su archivo privado contiene credenciales y
metadatos (ID, email, etiqueta opcional). `gmail.accounts` y `npm run gmail:accounts`
exponen solo metadatos; `gmail.identities` consulta Send As y devuelve únicamente
alias primarios o verificados. No configura alias ni acepta un From arbitrario.

Una cuenta explícita se selecciona por ID. Si una operación necesita una cuenta y
hay más de una, falla AMBIGUOUS: JARVIS debe preguntar. Una búsqueda sin accountId
consulta **todas** las cuentas; con ID solo esa. Los resultados incluyen cuenta,
mensaje e hilo para «¿En qué cuenta?», «Resumímelo» y «Respondé que…». Varias
coincidencias requieren que el usuario elija; no se resuelven mediante nombres
adivinados. Para un reply/reply-all, From se obtiene de los alias que recibieron el
mensaje (To/CC; Delivered-To solo si no hay coincidencias visibles); solo se infiere si hay uno inequívoco. Un correo nuevo
con varios alias requiere un From explícito. Reply-all excluye nuestras identidades
y nunca copia BCC del mensaje original.

Para configurar localmente:

1. En Google Cloud, habilitá **Gmail API** en el proyecto OAuth existente. Calendar
   sigue usando sus APIs y scopes existentes.
2. Configurá la pantalla de consentimiento y agregá cada cuenta como usuario de
   prueba mientras la aplicación esté en Testing. Para una aplicación externa,
   Gmail utiliza scopes restringidos: Google puede requerir verificación y, según
   el uso/almacenamiento, evaluación adicional. En Testing Google puede caducar
   los refresh tokens de estos scopes a los siete días; reautorizá cuando ocurra.
3. Reutilizá `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_REDIRECT_URI` del
   backend. El callback debe ser `http://127.0.0.1:3001/oauth/callback`; según el
   tipo de cliente, configurá esa URI como redirect autorizado en Cloud Console.
   La autorización abre un servidor loopback, con state aleatorio de un solo uso,
   PKCE S256 y vencimiento de cinco minutos. Ejecutá la CLI y el navegador en la
   misma máquina, no dos autorizaciones simultáneas en el mismo puerto.
4. Opcionalmente configurá `GMAIL_ACCOUNTS_PATH=.local/gmail-accounts`. Calendar
   conserva `GOOGLE_TOKEN_PATH=.local/google-tokens.json`; no se migra ni comparte
   su archivo. No hace falta reautorizar Calendar para empezar con Gmail.
5. Autorizá la primera cuenta y después cualquier cuenta adicional:

   ```powershell
   npm run gmail:authorize -- "Cuenta uno"
   npm run gmail:authorize -- "Cuenta dos"
   npm run gmail:accounts
   ```

   Elegí una cuenta diferente en cada consentimiento. Autorizar nuevamente la
   misma cuenta actualiza solo su archivo y conserva su ID. No edites los tokens
   manualmente. Reiniciá JARVIS después de gestionar cuentas y reconectá la voz.
6. Para desconectar una cuenta localmente:

   ```powershell
   npm run gmail:accounts -- --remove g_ID_OBTENIDO_DEL_LISTADO
   ```

   Reemplazá el ID por el completo del listado. No toca otras cuentas ni Calendar.
   Revocá también el acceso desde tu cuenta Google si corresponde.

Scopes solicitados por Gmail:

| Scope | Motivo |
| --- | --- |
| `openid` | Identificador estable `sub`; se verifica firma y audiencia del ID token. |
| `email` | Email verificado de la identidad, contrastado con el perfil Gmail. |
| `https://www.googleapis.com/auth/gmail.modify` | Búsqueda/lectura, adjuntos, borradores, envío, etiquetas y papelera; también permite **leer** Send As. |

`gmail.modify` es el scope necesario para las mutaciones reversibles de etiquetas
implementadas; evita pedir scopes redundantes de lectura/compose o
`gmail.settings.basic`. No se pide `https://mail.google.com/` y no existe herramienta
de borrado permanente. La especificación oficial consultada es
[Google Gmail v1 discovery](https://github.com/googleapis/google-api-go-client/blob/main/gmail/v1/gmail-api.json).

Los tokens usan los mismos `saveTokens`/`readTokens`/`GoogleAuth` validados:
reemplazo atómico, propietario y permisos privados en POSIX, ACL nativa privada y
rechazo de reparse points en Windows. Los archivos Gmail además rechazan ancestros
symlink y deben corresponder al ID/subject almacenado. Los archivos `g_*.json` y
`.local/` están ignorados. Un directorio o archivo inseguro falla cerrado; no se
corrigen permisos inseguros de archivos existentes silenciosamente. La carga es
opcional: no tener cuentas Gmail no impide iniciar voz, búsqueda ni Calendar.

### Herramientas y permisos

| Herramienta | Permiso y comportamiento |
| --- | --- |
| `gmail.accounts`, `gmail.identities` | READ; cuentas y From permitidos. |
| `gmail.search` | READ; query Gmail, remitente, destinatario To/CC/BCC, asunto, rango, Inbox/Sent, cuenta o todas. Paginación independiente por cuenta. |
| `gmail.getMessage`, `gmail.getThread` | READ; texto y referencias estables, adjuntos como metadatos. |
| `gmail.inspectAttachment` | READ; recuperación backend; texto UTF-8 opcional para plain/csv. |
| `gmail.createDraft`, `gmail.updateDraft` | WRITE; respetan TOOL_CONFIRM_WRITES; nunca envían. |
| `gmail.send` | SENSITIVE siempre; new, reply, replyAll, forward. |
| `gmail.sendDraft` | SENSITIVE siempre; revisa y congela un borrador existente. |
| `gmail.modifyMessage` | WRITE; archivar (quitar INBOX), leído (quitar UNREAD), no leído (añadir UNREAD), etiquetas existentes. |
| `gmail.trashMessage` | SENSITIVE siempre; papelera, no eliminación permanente. |

Antes de confirmar se resuelven cuenta, From verificado, To/CC/BCC, asunto, cuerpo,
hilo/referencias y bytes de adjuntos. La pregunta incluye esos datos y el texto
exacto; puede ser larga si el correo lo es. No se guarda un borrador, envía ni
modifica Gmail durante preparación. Tras «Sí, confirmo» u otro afirmativo admitido,
se ejecutan los bytes MIME congelados una vez. «No», caducidad, cambio de solicitud,
confirmaciones antiguas y sesiones cerradas conservan las protecciones V0.2.1.
Los fallos no se presentan como éxito; no hay retry automático de mutaciones.

Un borrador externo se normaliza a MIME de texto plano, manteniendo destinatarios,
contenido revisado, adjuntos y referencias de reply. Se vuelve a leer justo antes
de actuar; si cambió, falla CONFLICT. `sendDraft` envía una copia congelada con
`messages.send` y **conserva el borrador original**: así una edición concurrente no
puede cambiar lo enviado, ni hay una segunda mutación no atómica para borrar el
borrador. Después de éxito, el resultado identifica ese borrador retenido. No lo
envíes de nuevo desde Gmail por accidente. La comprobación de cambios no es una
transacción/ETag: una edición entre relectura y update puede ser reemplazada por
el contenido previamente aprobado; envío siempre conserva sus bytes aprobados.

Se usa MailComposer de Nodemailer para MIME y Mailparser para lectura RFC, sin
SMTP, acceso a archivos/URLs ni descarga de imágenes remotas. Un adjunto saliente
solo puede referenciar mensajes de la **misma cuenta**. Forward incorpora el texto
y adjuntos originales sin cambiar su cuenta; no reenvía silenciosamente un cuerpo
truncado. No se ofrecen subidas de archivos locales/URLs arbitrarias.

### Adjuntos, límites y errores

Los metadatos incluyen nombre, MIME, tamaño, attachmentId si existe y referencia
accountId/messageId/threadId/partId. El servidor verifica la referencia contra el
mensaje antes de recuperar bytes. No devuelve binarios al modelo, no guarda
adjuntos en disco ni genera URLs de descarga. `inspectAttachment` devuelve tamaño,
hash y opcionalmente texto plain/csv; otros formatos quedan listos para incorporar
parsers backend especializados en versiones futuras (PDF, hojas, imágenes, etc.).
El texto extraído y los correos son datos externos, nunca instrucciones.

Límites V0.3: hasta 20 cuentas, 10 resultados por cuenta/página (default 5), hilos
hasta 30 mensajes, texto hasta 6000 caracteres por mensaje y 30000 por hilo,
8 MiB por adjunto y por conjunto saliente, hasta 10 adjuntos y 50 destinatarios.
El límite HTTP existente de 16 KiB también aplica al JSON de entrada: preferí
correos cortos. Los cuerpos truncados se señalan explícitamente. No se cargan
binarios en la UI/Realtime. Una búsqueda global informa fallos por cuenta y
páginas pendientes; una página parcial nunca demuestra que alguien no respondió.
Los resultados normalizados no exponen errores de Google, credenciales ni cookies;
la telemetría existente no almacena cuerpos, destinatarios ni adjuntos.

Además de la deduplicación por invocationId del ejecutor, el adapter conserva
hasta 200 resultados de envío por proceso (incluidos fallos inciertos), usando una
huella de cuenta/contenido/adjuntos o ID/versión de borrador. Repetir contenido
idéntico no dispara otro envío mientras ese proceso siga vivo. No es una garantía
persistente de exactly-once: reinicios, otras instancias o envíos desde Gmail quedan
fuera. Ante un timeout, revisá Sent antes de reintentar; si se necesita reenviar el
mismo contenido deliberadamente, reconciliá el estado y reiniciá el servidor.
Un journal persistente de envíos es un seguimiento recomendado V0.3.x.

### Aceptación local Gmail

Después de autorizar dos cuentas, usando únicamente destinatarios de prueba:

1. «¿Qué cuentas de Gmail tengo conectadas?» y «¿Desde qué alias puedo enviar en
   esta cuenta?»: comprobá IDs y alias reales; no nombres/From inventados.
2. «¿Me respondió la persona que estoy buscando?» y «¿En qué cuenta?»; probá
   búsquedas globales, específicas, Inbox y Sent. Varias coincidencias deben pedir
   selección, nunca decidir automáticamente un hilo.
3. «Resumime este hilo» y «¿Qué me está pidiendo?»; comprobá cuenta, mensaje,
   fechas y adjuntos. Pedí extraer un adjunto de texto y verificá su contenido.
4. «Creá un borrador para mi destinatario de prueba…»: comprobá que existe pero
   no se envió. Probá editarlo y enviar el preparado; observá el borrador retenido.
5. «Respondé que el martes a las 15 me viene bien»: la pregunta debe indicar
   cuenta, From, destinatarios, asunto, cuerpo y adjuntos. Confirmá tras terminar
   la pregunta; comprobá un solo mensaje en Sent y su hilo.
6. Probá reply-all y forward con adjunto propio; verificá CC/BCC y From. Si hay
   dos identidades posibles, debe pedir aclaración.
7. Prepará un envío y decí «No»: no debe aparecer en Sent. Probá «sí» antes del
   final, cambiar la solicitud, caducidad y doble confirmación: no duplican envíos.
8. Marcá leído/no leído, archivá y pedí papelera: esta última siempre pregunta.
9. Repetí Calendar, web search, voz `cedar` e interrupción natural V0.2.2.

La autorización real y las pruebas de voz/envío se harán localmente. Las pruebas
cloud usan cuentas, mensajes, MIME y transportes falsos y nunca envían correo.
No se implementan contactos, watchers/background sync, borrado permanente,
parsers de documentos, journal persistente, descarga directa al navegador ni
procesamiento documental mediante otra llamada LLM en V0.3.
