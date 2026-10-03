# JARVIS V0.2 — Universal Tool Foundation

Asistente personal por voz: TypeScript strict, Node HTTP nativo, UI mínima sin framework, OpenAI Realtime y WebRTC. V0.2 añade herramientas sin reemplazar la arquitectura V0.1. El tag `v0.1.0` es la referencia conocida y no se modifica. Trabajar en `v0.2-tools`; no se publica ni mezcla automáticamente en `main`.

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
| `TOOL_CONFIRM_WRITES` | true por defecto; false permite WRITE sin confirmación. SENSITIVE siempre confirma. |
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

El tool devuelve pending y JARVIS debe leer la pregunta summary y esperar. Después de terminar esa pregunta, di «Sí», «Sí, confirmo» o «Confirmo»; «No» o «Cancela» rechaza. Solo se acepta aprobación de un nuevo item de voz iniciado después de finalizar la reproducción y ligado al ID pendiente; una transcripción antigua no puede aprobar. Espera a terminar la pregunta para confirmar por voz. Interrumpir la pregunta con un «Sí» anticipado cancela sin ejecutar; «No» puede rechazar incluso antes del final. Una frase distinta cancela la solicitud en vez de interpretarla mediante otro LLM. También puedes usar Confirmar/Cancelar en la UI. Si una transcripción falla, usa los botones o deja caducar la solicitud. Nunca hay un tool que permita al modelo otorgarse aprobación.

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

Fechas locales se convierten con Temporal en USER_TIMEZONE; offsets explícitos representan instantes. Se rechazan horas inexistentes/ambiguas en cambios DST y rangos invertidos. El agente recibe timezone y reloj al conectar. Para «mañana», construye desde el calendario local, no sumando siempre 24 h. Si falta duración, JARVIS pregunta. Un nombre requiere rango de búsqueda; varias coincidencias producen AMBIGUOUS y no mutan nada. Puede listar el rango y pedir al usuario escoger un ID. No se eligen silenciosamente eventos. Máximo 100 resultados; listas truncadas fallan explícitamente. No se gestionan series completas, asistentes, notificaciones ni movimientos de eventos de día completo en V0.2. Las mutaciones usan sendUpdates=none; prueba inicialmente con un calendario privado de pruebas.

Autorización inicial, en tu máquina local:

1. Crea/selecciona un proyecto en Google Cloud y habilita Google Calendar API.
2. Configura Google Auth Platform / pantalla de consentimiento. Para app personal externa en testing añade tu cuenta como test user. Los refresh tokens en testing pueden expirar en 7 días; vuelve a autorizar si procede.
3. Crea un cliente OAuth tipo **Web application** con redirect URI exacta `http://127.0.0.1:3001/oauth/callback`. La app y callback son servicios locales, no un login frontend público.
4. Introduce client ID y client secret en `.env` backend. Selecciona USER_TIMEZONE y GOOGLE_CALENDAR_ID. No compartas el archivo ni valores en chat.
5. Ejecuta `npm run google:authorize`. Abre la URL indicada en un navegador **de la misma máquina** y concede los scopes calendar.events y calendar.freebusy. El callback escucha solo en loopback y se cierra al finalizar o después de 5 minutos.
6. Reinicia JARVIS. No copies tokens al browser. El archivo `.local/google-tokens.json` contiene refresh/access tokens, se crea atómicamente con permisos 0600 y carpeta 0700. `.local/` está ignorado por Git. El código rechaza token files inseguros o symlinks. google-auth-library refresca access tokens y el backend persiste tokens renovados conservando refresh_token.
7. Para revocar, retira acceso en tu cuenta Google y elimina el token file privado. No registres su contenido. Si faltan credenciales, archivo o autorización, Calendar devuelve UNCONFIGURED sin impedir conversación/búsqueda.

El callback valida state aleatorio, consume una sola respuesta y usa PKCE S256. El OAuth completo necesita tu cuenta; no fue ejecutado con credenciales reales en cloud. Un callback de loopback requiere tu navegador local, no simplemente abrirlo desde una máquina distinta.

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

`npm test` incluye baseline V0.1, registry, permisos, READ/WRITE/SENSITIVE, rechazo, replay/concurrencia, expiry/IDs inválidos, errores/secretos, timeout, cancelación durante prepare, web search, Calendar fake, ambigüedad, If-Match, freeBusy, DST, OAuth file permissions, MCP allowlist/proyección, sesiones HTTP y voz con transcripciones antiguas. No usa tu cuenta Google ni simula que la voz real esté validada.

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
