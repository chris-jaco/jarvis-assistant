# Atlas V0.4.4 — Voice-first identity and interface

Asistente personal por voz: TypeScript strict, Node HTTP nativo, interfaz sin framework, OpenAI Realtime y WebRTC. V0.4.4 cambia la identidad a Atlas y la experiencia visual sobre la base aceptada V0.4.3 en `v0.4-memory`. Las secciones anteriores de versiones describen la evolución de herramientas, Gmail y memoria. La arquitectura validada, las credenciales y los tags anteriores se conservan. Esta versión requiere aceptación de voz local antes de publicarse como release.

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

El tool devuelve pending y Atlas debe leer la pregunta summary y esperar. Después de terminar esa pregunta, podés confirmar con lenguaje natural, por ejemplo «Sí», «Sí, confirma», «Confirmar», «Adelante», «Hazlo», «Sí, hazlo», «Sí, confirmo» o «Confirmo»; «No», «Cancela», «Cancelar» o «No lo hagas» rechaza. Solo se acepta aprobación de un nuevo item de voz iniciado después del output_audio_buffer.stopped de la respuesta nueva vinculada a la acción pendiente (response.created; no necesita un started correspondiente); cleared/interrupción no arma aprobación. La generación response.done no equivale al fin de reproducción. Realtime puede pedir otra herramienta antes de llegar la transcripción final del «Sí»: mientras haya confirmación pendiente el puente devuelve la acción congelada y bloquea la nueva ejecución, sin reemplazarla ni borrar su captura de voz. La captura conserva el ID pendiente y si el turno empezó tras la pregunta; una transcripción antigua no puede aprobar. Espera a terminar la pregunta para confirmar por voz. Un «Sí» anticipado se ignora sin ejecutar ni cancelar por cambio de solicitud; «No» puede rechazar incluso antes del final. V0.3.2 sustituye las listas de frases por clasificación semántica compartida en backend para todas las integraciones (ver abajo). También puedes usar Confirmar/Cancelar en la UI. Si una transcripción falla, usa los botones o deja caducar la solicitud. Nunca hay un tool que permita al modelo otorgarse aprobación.

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

Fechas locales se convierten con Temporal en USER_TIMEZONE; offsets explícitos representan instantes. Se rechazan horas inexistentes/ambiguas en cambios DST y rangos invertidos. El agente recibe timezone y reloj al conectar. Para «mañana», construye desde el calendario local, no sumando siempre 24 h. Si falta duración, Atlas pregunta. Un nombre requiere rango de búsqueda; varias coincidencias producen AMBIGUOUS y no mutan nada. Puede listar el rango y pedir al usuario escoger un ID. No se eligen silenciosamente eventos. Máximo 100 resultados; listas truncadas fallan explícitamente. No se gestionan series completas ni movimientos de eventos de día completo. Crear/actualizar reuniones con asistentes usa sendUpdates=all solo después de aprobación; las mutaciones sin asistentes y eliminación conservan sendUpdates=none; prueba inicialmente con un calendario privado de pruebas.

Autorización inicial, en tu máquina local:

1. Crea/selecciona un proyecto en Google Cloud y habilita Google Calendar API.
2. Configura Google Auth Platform / pantalla de consentimiento. Para app personal externa en testing añade tu cuenta como test user. Los refresh tokens en testing pueden expirar en 7 días; vuelve a autorizar si procede.
3. Crea un cliente OAuth tipo **Web application** con redirect URI exacta `http://127.0.0.1:3001/oauth/callback`. La app y callback son servicios locales, no un login frontend público.
4. Introduce client ID y client secret en `.env` backend. Selecciona USER_TIMEZONE y GOOGLE_CALENDAR_ID. No compartas el archivo ni valores en chat.
5. Ejecuta `npm run google:authorize`. Abre la URL indicada en un navegador **de la misma máquina** y concede los scopes calendar.events y calendar.freebusy. El callback escucha solo en loopback y se cierra al finalizar o después de 5 minutos.
6. Reinicia Atlas. No copies tokens al browser. El archivo `.local/google-tokens.json` contiene refresh/access tokens, se reemplaza atómicamente. En Linux/macOS conserva archivo 0600 y carpeta 0700 y exige propietario actual sin acceso de grupo/otros. En Windows usa ACL nativa: crea una carpeta privada con herencia desactivada para el usuario actual y SYSTEM, y verifica propietario y todas las reglas Allow del archivo/carpeta (solo usuario, SYSTEM o Administrators). No interpreta chmod como una ACL Windows. `.local/` está ignorado por Git. El código rechaza archivos no regulares, hard links, symlinks y carpetas inseguras antes de leer/escribir; en Windows también comprueba reparse points en el recorrido del path. Verifica la seguridad del temporal vacío antes de escribir tokens y lo elimina si falla. Windows requiere Windows PowerShell integrado y un filesystem con ACL (por ejemplo NTFS); si no puede verificar la seguridad falla cerrado como UNCONFIGURED, sin fallback a permisos simulados. Para una carpeta existente insegura no cambia permisos silenciosamente: utiliza una nueva carpeta de credenciales dedicada (por ejemplo GOOGLE_TOKEN_PATH=.local/oauth/google-tokens.json), autoriza de nuevo y retira de forma segura el archivo antiguo. Evita OneDrive/junctions o unidades FAT para este almacenamiento; una ruta privada fuera del checkout también sirve. Nunca guardes tokens en rutas versionadas. google-auth-library refresca access tokens y el backend persiste tokens renovados conservando refresh_token.
7. Para revocar, retira acceso en tu cuenta Google y elimina el token file privado. No registres su contenido. Si faltan credenciales, archivo o autorización, Calendar devuelve UNCONFIGURED sin impedir conversación/búsqueda.

El callback valida state aleatorio, consume una sola respuesta y usa PKCE S256. El OAuth completo necesita tu cuenta; no fue ejecutado con credenciales reales en cloud. Un callback de loopback requiere tu navegador local, no simplemente abrirlo desde una máquina distinta.


### Asistentes e invitaciones (V0.2.1)

Create acepta `attendees: ["sofia@example.com", "juan@example.com"]`: trim, minúsculas, validación de email, máximo 50 y deduplicación. Update permite cambios solo de asistentes sin mover horario, además de título/horario; si mueve debe enviar inicio y fin juntos. `attendeeMode: "add"` es el default y conserva asistentes existentes y RSVP; `"replace"`/`"remove"` requieren una solicitud explícita. replace con [] retira todos; remove retira los emails indicados. El cuerpo preparado y el resumen incluyen destinatarios finales y cambios antes de confirmar, y conservan ID/etag. Preparación solo lee, nunca invita. Un evento cambiado después de preparar falla If-Match sin retry automático. Una lista parcial de asistentes falla cerrada.

Mover/renombrar una reunión con asistentes también requiere aprobación para sus actualizaciones externas. Actualizaciones que no cambian asistentes omiten el campo del PATCH para conservarlos. Calendar detalles devuelve emails para revisión; no se añaden a telemetría. Un nombre como «Sofía» no resuelve un contacto: Atlas debe pedir email explícito, nunca adivinarlo. Un adapter de contactos futuro podría proporcionar esos mismos emails validados; no está implementado. La entrega de correo depende de Google y preferencias del destinatario, no está garantizada por una respuesta HTTP exitosa. Eliminación conserva su política previa de notificaciones.

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
«Hola Atlas, ¿me escuchás?», una pregunta sencilla, una explicación larga pedida
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

`src/core/personality.ts` centraliza instrucciones, REALTIME_MODEL, JARVIS_VOICE y TURN_EAGERNESS. Token/session comparten voz cedar y semantic VAD medium, createResponse=true e interruptResponse=true. Allí se pueden ajustar concisión/estilo y voz en versiones futuras; no se rediseña el comportamiento de interrupción en V0.2.

Mantiene autenticación GA `POST /v1/realtime/client_secrets` en backend, response mínima `{value: ek_...}`, WebRTC SDK/browser, contexto de sesión, history_updated/transcript, estados de reproducción, micrófono, controles y limpieza al desconectar. Ni la clave permanente ni tokens Google llegan a la UI. SDK tracing está desactivado y sensitive logging desactivado. Reconectar inicia contexto nuevo.

Servidor destinado a uso personal local en loopback. SameSite, comprobación de origen y cookie de sesión no sustituyen autenticación multiusuario, protección de red o límites por usuario. No expongas HOST=0.0.0.0 a una red pública sin esa capa. Asegura HTTPS si no usas localhost. La API local es autoridad del usuario local y no protege contra malware/extensiones o acceso a su navegador. Tratar fuentes de Internet/MCP como datos no fiables reduce riesgo de prompt injection, pero no lo elimina; revisa resúmenes antes de confirmar.

## Pruebas automatizadas y aceptación manual

`npm test` incluye baseline V0.1, registry, permisos, READ/WRITE/SENSITIVE, rechazo, replay/concurrencia, expiry/IDs inválidos, errores/secretos, timeout, cancelación durante prepare, web search, Calendar fake, ambigüedad, If-Match, freeBusy, DST, OAuth POSIX permissions/Windows ACL, Unicode paths, linked/unsafe files, cleanup antes de escribir secretos, MCP allowlist/proyección, sesiones HTTP y voz con transcripciones antiguas. No usa tu cuenta Google ni simula que la voz real esté validada.

Después de configurar OpenAI y autorizar Google, ejecuta npm run dev y abre la UI local. Usa calendario privado de pruebas y confirma timezone. Ejecuta **también npm run build && npm start** con el dev detenido para validar producción.

A. **Voz existente:** «Hola Atlas, ¿me escuchas?» Comprueba micrófono, audio, transcript y estados. Di «Me llamo Ana» y luego «¿Cómo me llamo?» para comprobar contexto.

B. **Información actual:** «Atlas, ¿qué pasó hoy con OpenAI?» Comprueba web.search ✓, respuesta actual con fuentes cuando disponibles y ausencia de afirmaciones inventadas si provocas un fallo de búsqueda.

C. **Leer Calendar:** «¿Qué tengo mañana?» Contrasta títulos y horarios en Google Calendar y USER_TIMEZONE; sin confirmación.

D. **Disponibilidad:** «¿Tengo algún hueco mañana por la tarde?» Si pide horario, di «de 15 a 20». Contrasta huecos reales con eventos/all-day en el calendario.

E. **Crear:** «Agéndame una prueba de Atlas mañana a las 18.» Si pide duración, di «30 minutos». Con TOOL_CONFIRM_WRITES=true debe preguntar resumen/horario; comprueba que NO existe aún. Espera el final de la pregunta y di «Sí». Debe aparecer un solo evento 18:00–18:30. Con false debe ejecutar sin confirmación de WRITE.

F. **Modificar:** «Mueve la prueba de Atlas a las 18:30.» Si pregunta duración, di «mantén los 30 minutos». Confirma si true; verifica 18:30–19:00 y que no hay duplicado. Si hay dos pruebas, debe pedir cuál sin mover ninguna.

G. **Eliminar:** «Elimina la prueba de Atlas.» Debe pedir fecha si falta o buscar en rango explícito acordado. Atlas **debe preguntar confirmación explícita con evento/fecha** incluso con TOOL_CONFIRM_WRITES=false. Antes de «Sí» comprueba que sigue existiendo. Después de confirmación, verifica eliminación. Un segundo «Sí» no debe ejecutar otra eliminación.

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
`[ATLAS confirmation]`, and connect/reconnect Atlas. Reproduce the correction
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
cookies or tokens are logged. No diagnostic trace is persisted by Atlas.

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
hay más de una, falla AMBIGUOUS: Atlas debe preguntar. Una búsqueda sin accountId
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
   manualmente. Reiniciá Atlas después de gestionar cuentas y reconectá la voz.
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


### V0.3.2: intención de confirmación compartida

Calendar y Gmail usan el mismo pending, bridge, endpoint `/api/tools/intent` y
`ToolExecutor.decide`. No existe un parser de afirmaciones de Gmail. El backend
clasifica el propósito de la intervención respecto del resumen congelado mediante
Responses API (`gpt-4.1-mini`, Structured Outputs estricto, `store: false`, sin
herramientas). Las únicas salidas son affirmative, negative, correction, unrelated
y ambiguous. Afirmar con cortesía o repetir brevemente la acción no requiere una
frase exacta; cambiar datos, introducir condiciones o mostrar incertidumbre nunca
es aprobación. El modelo clasificador no ejecuta ni altera acciones.

El ID se comprueba antes y después de clasificar; el bridge conserva la captura
original de elegibilidad y descarta resultados si cambió el pending, se cerró la
sesión o comenzó otra intervención. Las llamadas redundantes de Realtime se
bloquean mientras se espera la clasificación, la cancelación o la ejecución.
El ejecutor sigue consumiendo el ID una sola vez y comprobando la caducidad.
Una cancelación de voz también lleva el ID para no cancelar otra acción.

La clasificación añade una llamada de modelo, con límite de 8 segundos y sin
reintentos. Usa OPENAI_API_KEY únicamente en backend. El resumen de la acción y
la transcripción se envían a OpenAI como datos, sin credenciales ni logs de su
contenido. Un fallo, rechazo, salida inválida o ambigüedad nunca autoriza ejecución:
se cancela la confirmación sin ejecutar y se solicita aclaración. Los botones de
la UI conservan su flujo de decisión explícita. No se necesitan nuevas variables.

Las pruebas simulan las respuestas estructuradas del clasificador para verificar
el estado, la pertenencia a sesión y las carreras; no prueban que un modelo
probabilístico clasifique toda frase correctamente. Conservá esa comprobación en
la aceptación en vivo: probar «Perfecto, te confirmo el envío», afirmaciones
naturales, negativas, correcciones de destinatario/cuenta/contenido/adjuntos y voz
anticipada. No afirmar que un email se envió hasta `success` con `sent: true`;
un resultado incierto exige comprobar Enviados, nunca reintentar automáticamente.

Referencia oficial del formato de Responses consultada para este cambio:
https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts

## Atlas V0.4 — memoria contextual persistente

### Arquitectura y almacenamiento

`src/memory/` separa esquema, privacidad, almacenamiento, extracción, recuperación
y adapter. El historial Realtime/UI sigue siendo contexto de conversación; no se
archiva. Los registros semánticos duraderos son independientes. La secuencia y el instante de inicio de voz impiden que transcripciones antiguas sustituyan un turno nuevo. Los últimos seis
IDs relevantes forman contexto de trabajo de sesión, sin historial crudo ni
persistencia adicional. TEMPORARY usa una fecha UTC de caducidad.

`MemoryStore` ofrece lectura y transacciones de borradores síncronos. V0.4 usa JSON
versionado en `.local/memory/memories.json`: no añade bindings SQLite ni cambia el
mínimo Node 22.12. SQLite puede ser un siguiente adapter de almacenamiento, una vez
fijado un runtime/API adecuado para todas las plataformas. Los IDs/procedencia y
las reglas semánticas no dependen del formato físico.

La escritura crea un archivo temporal privado, sincroniza su contenido y lo
renombra atómicamente. Las transacciones se serializan dentro del proceso y usan
un lock exclusivo entre procesos. No ejecutar varios servidores simultáneamente:
V0.4 no coordina sus contextos/colas de extracción. Si un proceso muere dejando
`memories.json.lock`, detener todos los servidores y comprobar que ningún escritor
sigue activo antes de retirar **solo ese lock vacío**; no borrar la base. No hay
recuperación automática que pueda robar un lock activo. Máximo: 2.000 registros,
8 MiB de snapshot; no hay compactación/pruning autónomo ni garantía contra pérdida
por fallo físico del disco.

Los caminos configurables deben permanecer dentro de `.local`, ignorado por Git.
POSIX exige propietario actual, directorios privados y archivos sin permisos de
grupo/otros; se crean con 0700/0600. Windows reutiliza la validación ACL existente,
con acceso limitado al usuario y principals de sistema confiables. Se rechazan
symlinks, reparse points cuando aplica y archivos enlazados/inseguros. Un directorio
existente inseguro no se relaja ni se cambia a ciegas; memoria falla de forma segura.
El servidor bloquea caminos privados (incluidos @fs/encoded paths) antes de Vite y añade deny rules conservando sus defaults. No se sirven snapshots/tokens de .local por HTTP, ni en desarrollo. Los datos no están cifrados en disco: proteger el usuario del sistema y sus backups.

### Esquema y procedencia

Tipos: USER_PROFILE, PREFERENCE, PERSON, ORGANIZATION, PROJECT, SKILL, DECISION,
FACT, EPISODE y TEMPORARY. Cada registro tiene UUID estable, entidad/aliases,
clave semántica, contenido compacto, valores estructurados, relaciones tipadas,
procedencia/evidencia, timestamps UTC, confianza, importancia, corroboraciones,
estado y enlaces de supersesión; TEMPORARY requiere expiresAt.

Entidades usan IDs derivados de su identidad descriptiva; distintas identidades
con el mismo nombre provocan ambigüedad. No se precargan personas, emails, clientes
ni organizaciones de ejemplo. El modelo extractor debe reutilizar entidad/clave
para correcciones; una extracción incorrecta puede requerir inspección/corrección.

La prioridad normal es declaración explícita > evidencia de herramienta > sistema
> inferencia. Entre declaraciones explícitas prevalece la más nueva. Las inferencias
no sobrescriben datos explícitos y baja confianza se descarta. Los resultados actuales
de Calendar/Gmail se consultan con sus herramientas, no se sustituyen por recuerdos.
Menciones del mismo hecho actualizan un registro; cambios crean una versión nueva y
marcan la anterior superseded. Lo supersedido/caducado no se inyecta como vigente.

### Extracción automática, explícita y privacidad

Una transcripción de usuario real permite recuperar contexto y evaluar hasta cuatro
candidatos mediante Responses API, Structured Outputs, `gpt-4.1-mini`, sin tools ni
reintentos, `store: false` y timeout de ocho segundos. La extracción interpreta
semánticamente solicitudes explícitas y declaraciones estables sin exigir frases
exactas. No se procesan automáticamente respuestas del asistente, resultados de
herramientas, documentos o cuerpos completos de correo. La evidencia debe ser un
fragmento literal corto de la transcripción actual; no se acepta evidencia inventada.

Los candidatos se persisten fuera del camino de respuesta de audio, únicamente
cuando la sesión está libre. Si existe otra herramienta/confirmación, se cierra la
sesión o cambió el estado por una corrección/olvido, se descarta la escritura tardía.
Una eliminación impide que una extracción anterior resucite lo olvidado, también
entre sesiones del mismo backend. Las colas son limitadas; bajo carga puede perderse
una oportunidad de extracción: usar herramientas explícitas para datos importantes.

El filtro determinista de secretos corre **antes** de enviar la transcripción al
extractor y otra vez antes de persistir candidato/procedencia/snapshot. Bloquea claves,
passwords, tokens conocidos, códigos de autenticación, claves privadas, patrones de
tarjeta/IBAN y respuestas de seguridad. No depende de la decisión del LLM. Es
conservador: puede rechazar texto legítimo sobre autenticación y no puede reconocer
un secreto arbitrario sin patrón/contexto identificable. No dictar secretos para
memorizarlos. Datos relevantes y contexto limitado sí se envían a OpenAI; local-first
se refiere al almacenamiento, no a extracción completamente offline.

### Recuperación e integración Realtime

La recuperación combina aliases/entidades, relaciones, claves/valores, conceptos
léxicos bilingües, recencia, importancia, confianza y vigencia. `MemoryRelevance`
aísla el ranking para futuros embeddings; no hay vector DB. No es una búsqueda
semántica universal: paráfrasis/idiomas fuera de sus conceptos pueden perder matches.
Un nombre coincidente con varias entidades devuelve AMBIGUOUS; pedir identidad/alias
único, nunca elegir por ranking silenciosamente.

Solo se inyectan unos pocos registros dentro del presupuesto configurable. En la
conexión se recupera un pequeño perfil/preferencias; cada turno sustituye el contexto
anterior y revalida la vigencia. El contexto de trabajo se usa para referencias
anafóricas y nunca se convierte en autorización. No se envía todo el archivo.

El transporte envía un `session.update` mínimo con solo instructions (la API pública sendEvent) sin reemplazar el agente,
crear mensajes/turnos sintéticos ni modificar voz, modelo, WebRTC, VAD o barge-in.
Se evita updateSessionConfig parcial porque el SDK 0.18.0 rellena defaults de voz/VAD; no se cambian esos campos en la actualización de memoria. VAD puede empezar a generar antes de llegar la transcripción/recuperación: para
respuestas/decisiones que dependan de contexto previo, las instrucciones exigen
`memory.search` **antes de responder o preparar la acción** si el contexto no basta.
La recuperación por evento es complementaria, no una barrera temporal garantizada.
Memoria averiada nunca desconecta la voz; no se inventa contexto ni éxito de escritura.
Las validaciones nativas ACL de Windows pueden aumentar la latencia de almacenamiento.

### Herramientas y seguridad

| Tool | Permiso | Comportamiento |
| --- | --- | --- |
| memory.search | READ | Contexto relevante y acotado; ambigüedad explícita. Flags de inspección permiten ver incertidumbre/caducidad sin inyectarla como actual. |
| memory.get | READ | Inspección por ID interno; historical permite revisar versiones inactivas, nunca usarlas como vigentes. |
| memory.remember | WRITE, sin confirmación extra | Propuesta compacta; procedencia conservadora de inferencia si la propone el agente sin verificación directa. |
| memory.update | WRITE, confirmación obligatoria | Congela el registro/versión y el contenido/valores corregidos. |
| memory.forget | SENSITIVE | Selección exacta, confirmación y borrado físico de la cadena de versiones. |

La ingestión de transcripciones verificadas usa el mismo Registry/ToolExecutor mediante
un tool interno `memory.ingest`, oculto y rechazado por el endpoint de invocaciones del
modelo. No existe otro ejecutor ni una ruta de aprobación de memoria. Las operaciones internas tienen un presupuesto separado de 256 llamadas; mantienen validación/permisos/telemetría, no pueden ejecutar SENSITIVE ni WRITE con confirmación y no invalidan un pending. El límite original de 100 invocaciones del usuario permanece intacto. Las declaraciones
verificadas y el bootstrap aportan procedencia explícita; propuestas no verificadas del
agente no pueden elevarse a esa autoridad ni sobrescribir un hecho explícito.

Olvidar por ID o por coincidencia exacta única; nunca borrar por búsqueda difusa.
Ante varios recuerdos, preguntar cuál; si el usuario pide explícitamente TODO de una entidad, scope entity exige un nombre/alias exacto único y congela todos los recuerdos asociados por IDs/relaciones estructuradas (máximo ocho y resumen revisable). No selecciona por texto difuso. Todos se validan antes de borrar; si cualquiera cambió, no se elimina nada. Se borra la cadena supersedida del
recuerdo confirmado; no se conserva una copia de su contenido en telemetría.
Archivos `.tmp` se retiran; backups externos del usuario no se pueden borrar por esta API.

Las herramientas comparten validación, errores seguros, permisos y telemetría existentes. La recuperación contextual automática es una lectura interna de MemoryStore; no toma el lock de herramientas/decisiones ni consume su presupuesto. Toda mutación automática sí pasa por Registry/ToolExecutor con permisos, validación y telemetría.
No se loguean contenido, evidencia, identidades privadas ni rutas. Solo afirmar
recordado/corregido/olvidado tras un resultado que confirme persistencia/eliminación.
Un recuerdo de una persona no inventa su email ni remitente: Gmail conserva resolución
de cuenta/alias, payload congelado y confirmación SENSITIVE. El éxito de envío sigue
requiriendo `success` y `sent: true`.

### Configuración y bootstrap revisado

| Variable | Default | Uso |
| --- | --- | --- |
| MEMORY_PATH | .local/memory/memories.json | Snapshot privado dentro de .local. |
| MEMORY_CONTEXT_CHARS | 3000 | Presupuesto entre 500 y 8000 caracteres. |
| MEMORY_RETRIEVAL_LIMIT | 5 | Entre 1 y 8 registros relevantes. |
| MEMORY_AUTOMATIC | true | Extracción automática; herramientas siguen disponibles con false. |

No se requiere otra credencial aparte de OPENAI_API_KEY para extracción online. Si
falta, la memoria explícita por herramientas/bootstrap sigue disponible; no se finge
extracción automática. Configuración de memoria inválida deshabilita esa integración
sin impedir iniciar el asistente.

`npm run memory:bootstrap` lee un array JSON de candidatos revisados por stdin. No
contiene preferencias/personas personales hardcodeadas ni se ejecuta automáticamente.
El bootstrap utiliza la misma arquitectura y guarda origen explicit_user. Para la
preferencia de respuestas cortas/confirmaciones naturales, preparar un candidato
PREFERENCE con subject `{id: "user", name: "User", aliases: []}`, key estable,
content revisado, value estructurado, relationships `[]`, confidence/importance entre
0 y 1; preservar expresamente seguridad y detalles de la acción. Guardar el input
privado en `.local/reviewed-memory.json`, nunca en Git.

```sh
npm run memory:bootstrap < .local/reviewed-memory.json
```

PowerShell (UTF-8 explícito, también para Windows PowerShell 5):

```powershell
$jarvisPreviousEncoding = $OutputEncoding
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Get-Content -Raw -Encoding UTF8 .local\reviewed-memory.json | npm run memory:bootstrap
} finally { $OutputEncoding = $jarvisPreviousEncoding }
```

También se puede dictar la preferencia con voz como declaración explícita y comprobar
su persistencia. El comando imprime solo un resultado genérico. Cambios corregidos
se pueden inspeccionar y olvidar; no hay datos personales distribuidos como defaults.

### Aceptación local V0.4

1. Ejecutar install/typecheck/tests/build y conectar: «Hola Atlas, ¿me escuchás?».
   Comprobar voz cedar, transcript e interrupción natural.
2. Declarar «Mi pareja es Sofia». Pedir «¿Qué recordás de Sofia?». No debe inventar email.
3. Declarar un email **de prueba bajo tu control**. Reiniciar backend y sesión, pedir
   enviar a esa persona: resolver identidad/cuenta, preguntar si hay ambigüedad y
   confirmar la acción congelada; nunca enviar antes del backend success/sent:true.
4. Declarar «Frekuent es un cliente y estamos expandiendo a Portugal». Reconectar y
   preguntar «¿Qué estamos haciendo con Frekuent?». El ejemplo se guarda solo si lo dictás.
5. Declarar una entrega completa con año/fecha y corregirla a otra. Consultar: solo la
   versión nueva debe ser vigente. Inspeccionar procedencia y editar con memory.update.
6. Declarar contexto con plazo inequívoco. Tras caducar, comprobar que no influye.
7. Pedir olvidar un recuerdo; rechazar una vez, aprobar después. Reiniciar y confirmar
   que no está. Varios matches deben requerir aclaración y ninguna eliminación previa.
8. Saludos/relleno no deben producir recuerdos. No probar con secretos reales: usar
   ejemplos falsos etiquetados como password/token y comprobar que no se guardan.
9. Repetir Calendar READ/WRITE/SENSITIVE y Gmail SEND con afirmaciones naturales,
   negativas, correcciones y voz anterior al prompt. El bridge V0.3.2 sigue autoritativo.
10. Probar con almacenamiento inaccesible/configuración inválida: conversación sigue;
    no anunciar que guardó/olvidó nada. Verificar actividad sin datos personales.

Limitaciones: un usuario local y una instancia de backend; sin sync multi-dispositivo,
sin cifrado de aplicación, extracción/modelos probabilísticos que requieren aceptación
en vivo, selección exacta/alcance explícito para borrar, capacidad limitada y búsqueda semántica aproximada.
Para migrar, implementar otro MemoryStore y opcionalmente otro MemoryRelevance/extractor,
conservar IDs, relaciones, procedencia y supersesión y añadir un protocolo de conflictos
antes de sincronizar; no exponer el archivo privado directamente al navegador.

### V0.4.1: referencias de voz y correcciones literales

La resolución de entidades compara nombres y alias sin diferencias de caso,
acentos, espacios, puntuación ni guiones. Variantes de límites entre palabras
pueden recuperar una entidad canónica única. Si ya hay varias identidades con
la misma forma normalizada, se pide aclaración. Las personas con identidades
calificadas distintas siguen siendo distinguibles.

Las diferencias de letras no se resuelven automáticamente: una comparación
limitada genera hasta cuatro **nombres candidatos**, sin identificadores ni
permiso para ejecutar acciones. `memory.search` devuelve `clarificationRequired`
y el agente pregunta si se refiere a ellos. La escritura comprueba nombres y
alias dentro de la transacción y rechaza la creación de una entidad cercana
sin resolver. No se aprenden alias a partir de suposiciones ni se migran datos
privados existentes.

Para corregir nombres/identificadores, `memory.update` incluye `evidence` literal
del usuario; una corrección con identificadores exige esa evidencia. El backend
valida dominios visibles y secuencias de letras explícitamente deletreadas,
conservando sus letras sin heurísticas fonéticas B/V. También compara el payload
con los identificadores del último turno de voz aceptado, de modo que una
evidencia reformulada por el modelo no puede sobreescribir ese turno. La
extracción valida contra la frase original completa. Una incompatibilidad falla
antes de preparar la confirmación; si hay incertidumbre, se pide aclaración.
El nombre de una entidad puede corregirse por ID exacto con evidencia literal,
manteniendo su identidad y el mecanismo de supersesión/confirmación existente.
El backend recibe y congela el mismo valor que se presenta para confirmar.

El objetivo conversacional activo guía los seguimientos ambiguos: una inspección
de memoria continúa consultando memoria, mientras una solicitud explícita de
Internet/información actual conserva `web.search`. Esto se expresa en las
instrucciones centrales, sin un clasificador de frases españolas ni cambios al
motor de confirmación. La interpretación conversacional requiere validación
por voz real; las pruebas automáticas no garantizan decisiones perfectas del
modelo. Los filtros de deletreo dependen del texto que entregue STT: si éste
pierde las letras originales, Atlas debe pedir repetir/deletrear o aportar el
texto, no reconstruirlas por pronunciación.

Para la aceptación local: buscá una entidad existente usando variantes de
espacios/guiones, probá una variante de letras y verificá la pregunta de
aclaración; corregí un nombre de plataforma literalmente y deletreándolo,
revisá el summary antes de aprobar y verificá el nuevo valor tras reiniciar.
Probá después un seguimiento de la inspección de memoria y una petición
explícita de búsqueda web. No es necesario modificar el JSON privado a mano.

### V0.4.2: operaciones locales y diagnósticos de memoria

En Windows, cada invocación del verificador ACL abre PowerShell. V0.4.1 podía
abrir 21 procesos para una búsqueda: lectura de candidatos, otra lectura para
el ranking y una transacción para guardar `lastAccessedAt`, con comprobaciones
repetidas de directorios/archivo. Las búsquedas concurrentes se convertían así
en escrituras en cola. Los tests con almacenes falsos o permisos POSIX no
representaban este coste de arranque.

Ahora `memory.search` obtiene candidatos y ranking de un único snapshot, y
`memory.get`/las recuperaciones contextuales son lecturas sin bloqueo de
escritura. Las ACL del snapshot se validan en una sola invocación de PowerShell,
comprobando directorios, propietario, permisos y reparse points antes de leer
contenido. No hay caché de autorizaciones ni se omiten comprobaciones. Las
marcas de acceso se actualizan en memoria y se persisten con la siguiente
mutación, evitando reescribir el JSON por cada búsqueda; si se reinicia sin
otra mutación, esa última marca de acceso puede perderse, pero los recuerdos
persistidos se conservan.

Las mutaciones siguen serializadas por ruta y utilizan un lock exclusivo,
fichero temporal privado, fsync y reemplazo atómico. Se validan los directorios
antes de crear el lock, el snapshot/lock, el temporal antes de escribir y los
permisos de nuevo antes del commit. En Windows cada fase agrupa sus controles
en un proceso, sin cambiar las reglas ACL ni aumentar los timeouts. Una
transacción usa una lectura privada no encolada; su callback debe ser síncrono.
Los lectores pueden observar el snapshot anterior o el nuevo, sin esperar al
lock del escritor. Un lock extranjero/huérfano sigue fallando de forma segura.

La señal de cancelación del ejecutor llega a las operaciones locales y al
verificador ACL por lotes. Un trabajo cancelado en cola o antes del commit no
puede guardar más tarde; el cleanup mantiene el lock hasta terminar. Como en
cualquier escritura, un timeout después de iniciarse el reemplazo atómico
puede tener resultado incierto: verificá el estado antes de repetirla.

`memory.search`, `memory.get`, `memory.remember`, preparación/ejecución de
`memory.update` y preparación de `memory.forget` no llaman a OpenAI. La
extracción automática sí puede usar Responses, pero espera la red fuera de la
transacción y del bloqueo de herramientas. La confirmación por voz sigue
usando el clasificador semántico existente; eso es independiente de la
preparación local. Una propuesta del modelo mantiene su procedencia de
inferencia; para reemplazar un dato explícito existente se usa la corrección
confirmada, sin depender de extracción automática.

Durante `npm run dev`, los fallos producen entradas `[ATLAS memory]` con
`operation`, `stage`, `code` y `elapsedMs`. Incluyen cola, seguridad, snapshot,
validación, commit y operaciones públicas. No contienen rutas, nombres,
argumentos, IDs, contenido de memoria, mensajes originales, stacks ni secretos.
Los errores de producción permanecen normalizados y estos diagnósticos están
apagados. No hace falta activar `JARVIS_CONFIRMATION_TRACE` para verlos.

Las regresiones usan snapshots reales y latencia simulada por arranque ACL,
con límites de tiempo, llamadas directas sin red, lecturas/escrituras
concurrentes, cancelación y extracción automática bloqueada. Hay pruebas
nativas de ACL/reparse points que se ejecutan únicamente en Windows. Las
mediciones simuladas no sustituyen la aceptación en Windows: después de
actualizar, inspeccioná un recuerdo, guardá una nueva preferencia y corregí
una existente con confirmación. Si falla, compartí únicamente la línea de
metadatos `[ATLAS memory]`, nunca el JSON privado ni credenciales.

### V0.4.3 — preferencias y rendimiento en Windows

Para una preferencia explícita sobre la longitud de respuesta, `memory.remember`
acepta `{preference:{responseLength:"minimal"},evidence:"frase del usuario"}`.
Las opciones son `minimal`, `short`, `normal` y `detailed`. El backend construye
el sujeto genérico `{id:"user",name:"User",aliases:[]}`; no se necesita un
nombre ni ID personal. Este modo congela la propuesta y pide una confirmación
breve mediante el bridge existente antes de guardarla con procedencia
`explicit_user`. No cambia la extracción automática ni los permisos de otros
recuerdos. Nunca se afirma que se guardó antes de recibir éxito.

La preferencia actual de respuestas se busca por el sujeto canónico y la clave
existente (`spoken_communication`, `response_style`, `response_length` o un valor
`response_length`). Se conservan los otros ajustes estructurados y relaciones;
una preferencia equivalente reutiliza el registro y una nueva explícita crea
una versión que sustituye la anterior con enlaces de historial. Si hay varios
registros candidatos, se rechaza como ambiguo. Si cambia el registro mientras
se espera confirmación, se rechaza por conflicto. No se migra ni reescribe el
JSON privado durante el despliegue.

El fallo `write / validation / INVALID_INPUT` se reproduce con datos sintéticos:
algunos hashes hexadecimales de entidades parecen un IBAN al filtro conservador.
Después de validar el esquema del snapshot, el filtro omite exclusivamente los
IDs opacos `entity-<24 hex>` en los campos de identidad. El contenido, valores,
nombres, evidencia y entrada original siguen pasando por el filtro completo.
El payload original del fallo en vivo no está disponible: no se puede afirmar
qué ID concreto produjo el hash. Los errores ahora pueden indicar un campo de
una lista fija y una regla (`schema` o `secret_filter`), nunca el valor, payload,
ruta o nombre de una clave privada. `INVALID_INPUT` no justifica pedir un ID
personal ni repetir el mismo payload inválido.

En Windows, las auditorías por lotes usan un proceso PowerShell reutilizable,
con peticiones serializadas y respuestas fijas `OK`/`FAIL`. **No es una caché de
seguridad**: cada petición vuelve a comprobar propietario, ACL y reparse points
en toda la ruta. Un read mantiene una auditoría y una transacción mantiene las
cuatro auditorías de V0.4.2, incluidas las comprobaciones del temporal y antes
del reemplazo. Antes se iniciaban uno/cuatro procesos respectivamente; ahora
se inicia uno en frío y cero adicionales en caliente, hasta cierre por 60 s de
inactividad, error de protocolo, cancelación o timeout. El timeout sigue siendo
10 s. Un error de auditoría normal no concede acceso en peticiones posteriores.
La validación individual de archivos OAuth conserva su transporte original.
No se emplea una caché de ACL porque cambios de permisos/reparse points pueden
ocurrir sin un cambio fiable del tamaño o fecha del archivo.

Para medir en Windows, antes de `npm run dev` en PowerShell:

```powershell
$env:JARVIS_MEMORY_PROFILE="true"
npm run dev
```

En desarrollo se emiten tiempos sin contenido para `prepare`, `lookup`,
`execute`, `confirmation` (clasificación semántica), y para las etapas de store:
`queue`, `directory`, `lock`, `security`, `snapshot`, `validation`, `write`,
`sync`, `commit`. Son intervalos anidados: **no deben sumarse todos**.
`security` incluye arranque de PowerShell en frío y auditoría; comparar el
primer acceso con los siguientes permite observar el coste del proceso sin
omitir comprobaciones. No se registra el contenido ni se llama al modelo para
perfilar. En producción los diagnósticos de memoria permanecen desactivados.

La actividad de herramientas mantiene `durationMs` como tiempo total y añade
`preparationMs`, `confirmationWaitMs`, `executionMs`; la UI distingue ejecución
local y espera. La espera incluye la pregunta hablada, al usuario y la
clasificación semántica. El registro histórico de 37.667 ms no contiene este
reparto: no equivale a una escritura JSON de 37.667 ms ni permite reconstruir un
reparto exacto. La ejecución local no requiere red; la confirmación semántica
puede usar OpenAI. Linux valida la seguridad POSIX directamente. El entorno de
Codex no proporciona Windows nativo: las pruebas de ACL nativas siguen siendo
necesarias en Windows antes de afirmar tiempos reales en esa plataforma.

Prueba local: pedir «¿Podrías guardar y recordar para el futuro que tus respuestas
sean lo más cortas posible?», confirmar la propuesta, reiniciar y preguntar qué
preferencia recuerda. Repetir en inglés no debe crear otro registro actual.
Pedir luego respuestas detalladas debe sustituir la preferencia y conservar su
historial. Repetir la corrección `onavox.ai` → `onabox.ai` y comprobar que el
summary, contenido y valor son literales. Con profiling activo, comparar lectura
fría/caliente y la ejecución de la corrección **después** de la aprobación; no
editar manualmente `.local` ni pegar contenido privado para diagnosticar tiempos.

## Atlas V0.4.4 — identidad e interfaz por voz

Atlas es el nombre permanente del asistente. La voz sigue siendo `cedar`, con
español rioplatense ligero, voseo natural y respuestas cortas, directas y con el
resultado primero. Los hechos personales siguen en memoria, no en el prompt.
No se narran pasos internos salvo que una demora real necesite un aviso; los
errores no justifican inventar éxito ni reintentar escrituras sensibles.

La pantalla muestra el orb central (tocarlo conecta/desconecta), una transcripción
viva debajo y un estado secundario: Conectado, Escuchando, Pensando, Hablando o
Desconectado. La transcripción actualiza los mismos turnos mientras llegan
fragmentos; sigue el último turno salvo que estés leyendo mensajes anteriores.
No hay burbujas ni dashboard. La actividad/timings existentes se conservan en
«Detalles de sesión», cerrado por defecto. Interrumpir aparece sólo mientras
Atlas habla; Activar audio aparece si el navegador bloquea autoplay.

Módulos frontend:

- `src/client/orb.ts`: proyección de estados existentes y variables CSS.
- `src/client/audio-levels.ts`: análisis pasivo y ciclo de vida de Web Audio.
- `src/client/transcript.ts`: turnos incrementales y scroll.
- `src/client/confirmation-dialog.ts`: presentación del pending existente.
- `src/client/main.ts`: composición, controles de sesión y observadores.

El orb usa gradientes, reflejos y CSS sin dependencia 3D. Conectado respira
lentamente; Pensando muestra un arco lento y no responde al audio. Escuchando
usa **el mismo MediaStream de micrófono** ya capturado por el provider, sin otro
getUserMedia. Hablando usa **audio.srcObject**, el MediaStream remoto que asigna
el SDK WebRTC instalado. Los analizadores se conectan a fuentes pasivas, nunca
al destino de audio: no duplican reproducción ni cambian VAD/WebRTC. La energía
RMS tiene umbral de ruido, normalización, límite y suavizado attack/release. No
hay pulsos aleatorios durante habla. En una interrupción se cambia a la energía
del usuario con transiciones visuales, sin cancelar nada desde el orb.

El AudioContext se prepara dentro del clic de conexión y se reutiliza al llegar
el stream; si el navegador lo suspende puede reactivarse con Activar audio.
Si Web Audio no está disponible, la voz continúa y el orb conserva el estado,
sin fingir amplitud. AudioContext, nodos, listeners y requestAnimationFrame se
liberan al desconectar; callbacks antiguos no reactivan el análisis. No se paran
tracks desde la visualización: esa propiedad sigue en el provider. Al abandonar
la página se desconecta; volver desde el back/forward cache recarga la interfaz
para no revivir listeners ya liberados. `prefers-reduced-motion` elimina giros,
respiración y deformación, conservando estado e intensidad medida.

### Confirmación multimodal

El diálogo sólo aparece con un pending y muestra **su summary congelado** como
texto. No reconstruye remitentes, destinatarios, adjuntos ni parámetros desde
el cliente; tampoco muestra payloads, IDs técnicos o credenciales. Todos los
detalles necesarios de seguridad del summary se conservan, incluso si es largo.

Voz y botones llegan al **mismo VoiceToolBridge / ToolExecutor**. Un clic envía
la decisión con el ID mostrado; el provider lo compara con el pending actual
antes de delegar. Escape equivale a Cancelar, nunca a aprobar. No se cierra
optimistamente por un clic: espera la actualización del bridge/backend. Las
resoluciones por voz cierran el mismo diálogo. El doble clic se bloquea en la
vista; los IDs congelados, caducidad, consumo antes del await y protecciones de
carreras existentes siguen siendo la autoridad. El diálogo enfoca Cancelar al
abrirse, usa el focus trap nativo y devuelve foco al control anterior al cerrar.
La expiración local sólo deshabilita controles; no concede autorización.

### Compatibilidad y aceptación

El repositorio `chris-jaco/jarvis-assistant`, carpeta, nombre interno del paquete,
constantes `JARVIS_*`, variables `JARVIS_CONFIRMATION_TRACE` /
`JARVIS_MEMORY_PROFILE` y rutas `.local` se mantienen por compatibilidad. Los
logs públicos ahora usan `[ATLAS confirmation]` / `[ATLAS memory]`; no cambia su
contenido permitido ni las condiciones de activación. No se migra memoria ni
se cambia OAuth, Calendar, Gmail, permisos, bridge semántico o almacenamiento.
`jsdom` se usa sólo como dependencia de desarrollo para pruebas de DOM; no llega
al bundle servido. El orb no incorpora dependencias de producción nuevas.

Aceptación local (Chrome/Edge en Windows, localhost/HTTPS):

1. Conectar tocando el orb, decir «Hola Atlas, ¿me escuchás?» y comprobar Tú/Atlas,
   fragmentos y texto final. Susurrar/hablar normalmente debe cambiar su energía.
2. Pedir una explicación e interrumpir: el orb debe seguir tu voz sin cortar el
   micrófono ni alterar barge-in. Pedir datos actuales y observar Pensando hasta
   que lleguen la respuesta y el audio; Hablando sigue la reproducción real.
3. Preparar una acción sensible de prueba (por ejemplo una eliminación de Calendar
   o un Gmail a una cuenta propia). Revisar el summary completo. Confirmar por
   voz: el diálogo debe desaparecer y la acción ejecutarse una sola vez.
4. Repetir con Confirmar, luego pronunciar «sí»: debe haber una única ejecución.
   Repetir con Cancelar y Escape: nada se ejecuta. Cambiar la solicitud y comprobar
   que un diálogo viejo no aprueba la acción nueva. Dejar caducar una propuesta.
5. Leer transcripción anterior mientras llega otra respuesta: no debe forzar el
   scroll al final. Probar teclado, viewport móvil y movimiento reducido del SO.
6. Repetir conexión/desconexión durante captura y reproducción; comprobar que el
   micrófono se libera y no se multiplican analizadores. Validar Calendar, Gmail,
   búsqueda, preferencia persistente V0.4.3 y corrección literal Onabox.

Las pruebas automáticas no usan cuentas ni Realtime real. Las comprobaciones en
Chromium con streams de audio sintético verifican RMS, silencio, diálogos, foco,
Escape, responsive y reduced motion; no sustituyen esta aceptación en vivo ni
validan voz/acento en Windows/Safari. Si el stream remoto aún no llegó o está
pausado/silenciado, el estado puede indicar Hablando sin amplitud; no se inventa
una onda para ocultarlo.

### Refinamiento visual de Atlas V0.4.4

El header conserva la tipografía de «Atlas.» y añade el símbolo suministrado.
`public/brand/atlas_blanco.png` es una copia intacta de la variante blanca del
ZIP (`Imagen de ChatGPT 5 oct 2026, 15_55_20.png`), adecuada para el fondo oscuro.
`atlas-icon.svg` incorpora exactamente esos bytes y recorta sólo los márgenes
transparentes mediante viewport; no traza ni redibuja la silueta. Sirve también
como favicon autónomo, sin texto ni fondo, manteniendo proporciones.

El header lo colorea no destructivamente con una máscara CSS y
`--atlas-accent: #35E6D0`, compartido por icono, punto de marca e indicador activo.
Conectando/desconectado/error mantienen el indicador neutro. El icono del header mide 1.25rem (un 22% menor que antes). El favicon es negro,
independiente del accent, con la misma silueta y transparencia.
La tarjeta de confirmación sólo cambia superficie, borde, radio, sombra y
padding. Voz, IDs, payload congelado, botones, foco y protección de carreras se
mantienen en los módulos validados sin cambios.

## ATLAS V0.5 Browser Control — Foundation

Browser Control controla un navegador **visible en la máquina que ejecuta el
backend**, no en el dispositivo que sólo abre la UI. No sustituye `web.search`:
para información actual basta esa herramienta; «abrí YouTube y buscá Arctic
Monkeys» implica acciones sobre el navegador y usa `browser.*`.

### Arquitectura y arranque

`Realtime → Universal Tool Registry → BrowserAdapter → BrowserProvider →
LocalBrowserProvider → Playwright → Chrome/Edge visible`.
El contrato `src/browser/provider.ts` no contiene tipos de Playwright ni permite
JavaScript/selectores del modelo. Un futuro Cloud/Android provider implementará
ese contrato sin cambiar las tools. Las tools pasan por el executor, validación,
timeouts, replay protection y telemetry existentes. No se crea otro flujo de
confirmación ni se toca el validado de Calendar/Gmail/Memory.

1. `npm install` (Node >=22.12); Playwright 1.63.0 queda fijado en el lockfile.
2. Instalá Chrome o Edge normal. En `.env`, configurá `BROWSER_ENABLED=true` y
   `BROWSER_CHANNEL=msedge` (Windows) o `chrome` (macOS/Linux). Para Chromium:
   `npx playwright install chromium` y `BROWSER_CHANNEL=chromium`.
3. `npm run dev`. El navegador se lanza al primer uso de `browser.tabs/open/...`,
   siempre con `headless:false`. `browser.status` sólo informa, sin lanzarlo.
   Se requiere una sesión gráfica local; no hace falta puerto CDP ni extensión.
4. Decí «Atlas, abrí YouTube y buscá Arctic Monkeys». Después probá otra pestaña,
   volver a YouTube, abrir un resultado y pausar el video.

Se eligió `chromium.launchPersistentContext` con un perfil **dedicado** en
`.local/browser-profile/`, nunca el perfil personal. No copiamos cookies ni
credenciales, ni adjuntamos una instancia arbitraria por CDP. Playwright advierte
que el perfil principal de Chrome moderno no admite esta automatización:
[API oficial](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[cambio oficial de Chrome](https://developer.chrome.com/blog/remote-debugging-port).
No se modifican flags de seguridad del navegador en producción.

`.local` y el directorio del perfil se validan sin symlinks, con permisos privados
POSIX o la validación ACL Windows existente. El perfil contiene datos privados
persistentes del navegador, está ignorado por Git y no se sirve al frontend.
Sólo una instancia puede utilizarlo a la vez. No cambies su ubicación al perfil
normal. Al apagar el backend se cierra el contexto administrado; al reconectar
la voz, el navegador existente permanece. Los IDs opacos de pestañas duran el
contexto del navegador, no son índices ni recuerdos semánticos. La pestaña activa
es la seleccionada por Atlas; cambiarla a mano en Chrome no cambia esa selección.

### Tools y observación

`browser.status`, `tabs`, `open`, `navigate`, `switch`, `close`, `observe`, `click`,
`type`, `press`, `scroll`, `back`, `forward`, `reload`.
Todas usan schemas estrictos. Observación y listado son READ; las interacciones
reversibles son WRITE sin confirmación en esta versión. **Esta clasificación no
habilita acciones consecuenciales**: el provider aplica su política además del
executor. V0.5.1 podrá preparar acciones con el sistema de aprobación existente;
V0.5.0 no contiene una vía para aprobar/enviar/comprar.

`observe` devuelve URL sin query/fragment, título acotado y hasta 40 controles
visibles (10.000 caracteres de elementos), con role/nombre/tipo/estado/ref y clase
`navigation/search/media/blocked`. Se usan etiquetas/ARIA y controles visibles,
no HTML completo, screenshots ni dumps. Las refs se invalidan tras una acción,
navegación, cambio de pestaña o mutación DOM. `CONFLICT` requiere observar otra
vez. `type` distingue `replace/append`; las teclas están enumeradas y su uso se
restringe según el control. No hay `evaluate`, CSS libre ni tools por sitio.

### Seguridad, privacidad y límites V0.5.0

La política es conservadora: links de navegación se siguen por GET directo,
sin ejecutar su `onclick`; sólo se permite escribir en búsquedas identificadas,
activar sus botones y controlar elementos HTML audio/video. Controles ambiguos,
credenciales, formularios generales y acciones de enviar/publicar/comprar/pagar/
reservar/eliminar/cancelar/modificar cuentas quedan bloqueados antes de accionar.
Se rechazan esquemas no http(s), URLs con credenciales o parámetros de secretos,
destinos locales literales y rutas/consultas evidentemente consecuenciales.
No se ejecutan retries automáticos. El provider bloquea métodos distintos de
GET/HEAD/OPTIONS, WebSockets, service workers, descargas y diálogos de página.
Esto puede limitar páginas que requieren POST incluso para funciones de lectura.

La clasificación semántica de una web no es una garantía universal: una web
maliciosa podría causar efectos mediante GET o etiquetar engañosamente un
control. Usá este navegador para navegación/búsqueda en sitios de confianza;
no lo uses para flujos de cuentas, operaciones financieras o mensajes. Los
controles no reconocidos fallan cerrados; no intentes habilitarlos con prompts.
El usuario conserva el control manual del navegador, fuera de las tools de Atlas.
`observe` reconoce dialogs/modals visibles y devuelve sólo sus controles, excluyendo
el contenido detrás y controles tapados. La extracción es una instantánea acotada;
no evalúa ni dispone cientos de elementos individualmente. Las refs conservan
la revisión del documento: si cambia, hay que observar de nuevo.
En un diálogo de cookies sólo botones explícitos para rechazar opcionales o
aceptar cookies necesarias pueden recibir la clase `consent`. Aceptar todas,
cambiar privacidad/cuentas y controles desconocidos siguen bloqueados. No se
agregan excepciones por sitio ni se permite POST: si el consentimiento necesita
ese método, está en un iframe o no se identifica, resolvelo manualmente. Tras el
click, observá de nuevo para verificar que el modal desapareció; un click exitoso
no garantiza que el consentimiento haya quedado guardado.

No leemos cookies, headers, localStorage/sessionStorage ni valores de inputs.
Se excluyen passwords, OTP y campos de tarjeta; se redaccionan nombres que
parecen credenciales. No se registran contenidos de páginas, URLs de tools,
screenshots ni errores crudos de Playwright. Sólo sale al modelo la observación
compacta solicitada; aun así los títulos/nombres de controles pueden ser datos
privados: observá únicamente páginas cuyo contenido quieras compartir con Atlas.
Los resultados de browser nunca ingresan automáticamente a Memory. El estado de
pestañas es transitorio y separado de la memoria semántica.

### Troubleshooting y aceptación

- Deshabilitado: `browser.status` indica `reason:disabled`; voz, Calendar, Gmail,
  Memory y web search siguen disponibles. Activá la variable y reiniciá.
- No instalado/sin display/perfil ocupado/permisos inseguros: la operación falla
  con `UNCONFIGURED`, y status indica `unavailable`; no devuelve rutas privadas ni
  errores crudos. Instalá el canal elegido, cerrá la otra instancia del perfil y
  verificá permisos. No cambies permisos a públicos para hacerla funcionar.
- Ref caducada: nueva observación; no reutilices una ref tras escribir/click.
- Elemento no visible/iframe/DOM muy dinámico/consentimiento: puede necesitar
  interacción manual. Esta foundation observa sólo el documento principal;
  no promete resolver todos los sitios. El título y URL ayudan a elegir tabs;
  si hay varias coincidencias, Atlas debe preguntar.
- Los tests usan fixtures deterministas con Chromium, no YouTube ni cuentas
  reales. `npx playwright install chromium` instala el navegador de test; en esta
  nube se usó `/usr/bin/chromium`. `TEST_BROWSER_EXECUTABLE` es sólo para tests.
  Si falta un ejecutable se marca explícitamente omitida esa prueba, no aprobada.
  Los tests pueden correr headless; el provider de producción siempre es visible.

Aceptación local Windows: comprobá voz/transcript/barge-in primero. Pedí abrir
YouTube y buscar Arctic Monkeys; verificá ventana visible, texto y resultados.
Pedí «abrí otra pestaña y buscá la web de OpenAI», «volvé a YouTube», «abrí el
primer resultado» y «pausalo»; verificá selección por IDs y pausa real. Probá una
acción de envío/compra: debe detenerse sin ejecutarla. Apagá Browser Control y
verificá que conversación y herramientas anteriores siguen funcionando. Estos
pasos en Windows con voz/sitios reales requieren aceptación manual; los tests de
fixtures no certifican la voz ni la UI de YouTube actual.

### Browser Control: diagnostics del runtime real

`BROWSER_TRACE=true` (reiniciar el backend y reconectar la voz) habilita logs
`[ATLAS browser]` en la terminal del servidor y en la consola de la UI. La flag
vale también con el build de producción; por defecto está deshabilitada.

Cada petición Browser usa un ID diagnóstico generado por el servidor (`b1`,
`b2`, ...), no el ID del SDK, ni el cookie de sesión. El bridge añade un contador
local de petición y recibe el ID diagnóstico en un header dedicado. Los logs
unen `realtime_received → http_received → adapter → provider_initialization →
browser_launch → navigation → provider_result → executor_result → http_result →
realtime_result`. También separan validación de perfil, preparación del contexto,
evaluación de pestañas iniciales y creación/metadatos de tabs. Indican canal
Chrome/Edge/Chromium y flags connected/initializing; no exponen `.env`, rutas,
URLs, inputs, páginas, DOM, cookies, headers de autenticación ni errores crudos.

`duplicate:true` identifica la repetición de un ID de invocación dentro de la
misma sesión, preservando la protección de replay existente. `initialization_wait`
muestra otra llamada esperando la inicialización ya en marcha. `http_busy`
indica rechazo 429, no una cola esperando. `session_closed/replaced/expired`
permite distinguir un abort de sesión del watchdog de ejecución, que mantiene
18s para Browser; fetch HTTP y la tool del SDK mantienen 30s. Un abort conserva
el ID de la llamada original aunque se dispare desde otra petición HTTP.

Los diagnostics son observacionales: no cambian autoridad, locks, retries,
confirmaciones, AbortSignals ni duración de los timeouts. BrowserProvider sigue
siendo compartido por el runtime, mientras los executors son por sesión; cerrar
la voz no cierra el contexto del browser. Los tests ejercitan el bridge del SDK,
el handler HTTP y Chromium con fixtures y requests persistentes, más replay,
status, reconexión y cancelación. No atribuyen un fallo real de Windows a una
causa hasta tener sus trazas. Para diagnóstico, capturá las líneas del servidor
y de la consola desde antes del comando de voz hasta el resultado (o timeout),
manteniendo la UI en una sola pestaña para identificar sesiones inesperadas.

### Inicialización Windows y watcher de desarrollo

Vite excluye toda `.local` de su watcher, además del bloqueo HTTP de archivos
privados. Esto evita observar archivos de sesiones de Chrome y sus errores
`EBUSY`. No implica copiar perfiles ni cambiar permisos.
La preparación del perfil usa `TokenFileSecurity.validateMany`, con el worker
PowerShell reutilizable ya utilizado por Memory: auditorías frescas del padre
antes del hijo, sin cachear permisos ni arrancar un shell nuevo por directorio.
Mantiene validación de owner/DACL/reparse points y permisos POSIX privados;
la cancelación impide continuar al launch tras una auditoría abortada.
Los presupuestos siguen siendo 18 s por tool, 12 s de launch y 8 s de navegación.
La traza Windows previa consumía 7,6 s en dos shells ACL y 5,2 s en launch,
dejando apenas 4,2 s para navegación. El cambio elimina arranques redundantes
y el watcher del perfil, pero las mejoras exactas deben medirse nuevamente en
Windows con `BROWSER_TRACE=true` (desactivado por defecto). No se atribuye toda
la duración de launch al watcher sin una medición posterior.

## V0.5.1 — Attached Chrome (acceptance Windows pendiente)

Atlas puede usar una pestaña de tu Chrome habitual mediante extensión MV3 y
Native Messaging, con autorización explícita por tarea/sesión y revocable.
No copia perfiles ni lee cookies, passwords, storage o headers. El proveedor
aislado sigue siendo el default (`BROWSER_PROVIDER=isolated`); attached es opt-in,
sin fallback automático. La extensión usa `activeTab`, `scripting`, `nativeMessaging` y `storage` para
preferencias propias; declara `optional_host_permissions: ["https://*/*"]` y
solicita cada sitio HTTPS individualmente mediante un gesto en el popup. No cierra Chrome ni tus tabs al desconectar Atlas.

La instalación manual Windows, configuración, protocolo, límites de seguridad,
reconexión, uninstall y pruebas A–L están en
[docs/browser-attached.md](docs/browser-attached.md). Los tests automatizados no
constituyen acceptance de tu Chrome real; V0.5.1 todavía no está publicada como
release. Una autorización de tab y una reanudación “listo” nunca sustituyen las
confirmaciones de acciones consecuenciales existentes.

V0.5.2.1 (working tree, acceptance Windows pendiente): separa ejecución de
verificación, aplica silencio RUNNING en audio/transcript y añade diagnostics
opt-in del popup. La admisión permite un único acknowledgement inicial opcional; luego RUNNING y RECOVERING_CONTEXT son silenciosos. No añade una ronda para la conversación ordinaria.
Contrato, configuración y límites en [browser-attached.md](docs/browser-attached.md#v0521--estabilización-de-resultados-y-presentación).

### Browser task lifecycle stabilization (unreleased)

A response ending, an acknowledgement ending, a tool returning and an observation
returning do **not** end a browser task. One optional initial acknowledgement is a
very short acceptance, without a plan or viability assessment. Tools start without
waiting for playback; intermediate RUNNING/RECOVERING_CONTEXT output remains silent.

Access/context continuation events have RECEIVED → PENDING → DELIVERED → CONSUMED
states. Events arriving during a tool are deferred and coalesced. The HTTP output
includes a task-scoped receipt, including events discovered during its final READ
refresh. Only the SDK `agent_tool_end` event, emitted after committing the function
output and requesting its next response, consumes that receipt without another
response. Remaining events get one silent internal continuation. A same-origin,
session-authenticated acknowledgement endpoint removes matching backend tokens;
old-task or invented token IDs cannot acknowledge another task. Events arriving
after SDK response creation wait for that decision; they do not create a parallel
response. Superseded pending identities are discarded when the backend provides
a new authoritative receipt. Neither receipts
nor acknowledgement endpoints execute browser actions.

`browser.endTask` accepts `{ reason, evidence?: { actionId } }`. Reasons are:

- `COMPLETED`: ACTION_REQUIRED needs a completed relevant action in this task;
  READ_ONLY needs sufficient current-admission READ context. Both require fresh
  authorized context, no pending workflow/continuation/confirmation/recovery and
  no unknown execution. A supplied actionId must name the latest relevant action.
  Available effect conditions must be verified. The trusted initial/new user-task
  admission resets only the progress ledger, so earlier objectives cannot provide
  completion evidence. It does not reset refs, recovery budgets, duplicate-action
  protection, unknown execution or Chrome/site permissions. Preparatory tabs/access/switch/
  observe alone cannot close an ACTION_REQUIRED task. A READ_ONLY task instead
  requires fresh sufficient context obtained during its current admission.
- `CANCELLED`: explicit user cancellation, recorded through the non-model browser
  lifecycle endpoint. For voice, say **“Atlas, cancelá la tarea del navegador.”**
  This is distinct from any pending action confirmation; a model reason alone
  cannot manufacture cancellation.
- `TERMINAL`: a recorded nonrecoverable failure, revocation or manual challenge.
- `INCONCLUSIVE`: exhausted context recovery or applicable effect-verification
  budget, retaining known execution semantics.

Missing reasons (including legacy `{}`) and unsupported closure claims return
`END_TASK_REJECTED / OBJECTIVE_PENDING` as a business result. The task/grants/refs
are retained, RUNNING continues silently, and the model must choose the next
necessary distinct step. Repeated identical rejections share one continuation
identity. This is a structural guard, **not** a universal objective verifier:
playback evidence does not prove content identity or requested duration. Admission freezes READ_ONLY or ACTION_REQUIRED from the captured user transcript,
never from model tool arguments. Narrow unambiguous reading requests qualify as
READ_ONLY; missing, ambiguous or mixed requests default to ACTION_REQUIRED. Page
reading requires a fresh authorized snapshot from the current admission; tab
inventory requires a fresh READ of authorized tabs only, even when empty. Existing
pending, grant, unknown-execution and applicable verification guards remain.
The first browser call waits at most 1.5 seconds for its captured speech turn;
a late transcript cannot change the admitted classification. The backend neither
retains nor logs the raw transcript used for classification.
Verification remains optional for continuing a multi-step task; it never repeats
an executed action. EXECUTION_UNKNOWN still blocks retries, including after task
closure or fresh observations.

With `BROWSER_TRACE=true` only, `[ATLAS browser task]` diagnostics report opaque
identifiers, task states, token states, tool-in-flight state, closure decisions and
sanitized workflow outcomes/reasons. They omit arguments, page data, titles, URLs,
written values and credentials. No extension permission, site policy, Search/Media,
Native Messaging or consequential-action confirmation changes are required.

Minimum Windows acceptance after publishing this patch separately:

1. Start attached mode; request a multi-step search/play task. Expect at most one
   brief acknowledgement, then silence while tools run.
2. Authorize the tab if requested. Verify the task resumes once, uses fresh refs
   and performs actions beyond tabs/access/switch/observe before completion.
3. If auto-observation fails, verify only bounded READ recovery occurs; no completed
   type/click/press is repeated to verify its effect.
4. Test the explicit browser cancellation phrase and a revoked grant. Neither may
   be reported as successful objective completion. Chrome stays open.
5. If a premature closure is diagnosed, expect OBJECTIVE_PENDING and continuation,
   not a final answer or scope teardown. Repeat with tracing enabled only when needed.
