# ATLAS V0.5.1 — Chrome personal (acceptance pendiente)

Esta implementación está preparada para pruebas reales en Windows, no constituye un release aceptado. Los tests de Chromium usan fixtures y los del host usan procesos .NET reales; no prueban la instalación HKCU ni el permiso `activeTab` de tu Chrome en Windows.

## Arquitectura

`Realtime → HTTP por sesión → BrowserAdapter → Tool Registry / ToolExecutor → AttachedChromeProvider → broker .NET → pipe privado → Native Messaging host → extensión MV3 → content script aislado`.

`BROWSER_PROVIDER=isolated` conserva el proveedor Playwright existente, expuesto también como `IsolatedBrowserProvider`. `attached` requiere selección explícita; no hay fallback automático. Chrome personal conserva su red, service workers y sesiones normales. Atlas no copia ni abre archivos del perfil y no extrae cookies, passwords, storage ni headers.

El host usa .NET 8, framing Native Messaging de cuatro bytes little-endian, JSON UTF-8 y máximo 64 KiB (también para los envelopes internos). stdout contiene sólo frames; stderr contiene únicamente una categoría fija. Un broker exclusivo por usuario multiplexa hasta diez conexiones Chrome mediante un named pipe `CurrentUserOnly`, derivado del SID. Esto reemplaza el archivo rendezvous propuesto: no hay archivo/token de conexión que almacenar. El handshake exige el origen exacto de la extensión. La frontera protege de otros usuarios del sistema; no protege frente a malware ejecutado como el mismo usuario.

El protocolo `atlas.browser/1` tiene schemas estrictos, UUIDs de request/sesión/tarea/epoch, deadline y deduplicación por ID + payload. Incluye status, listAuthorizedTabs, requestTabAccess, revokeTabAccess, openTab, navigate, observe, click, type, press, scroll, back, forward, reload y media. Añade sólo activate, endTask y endSession para mantener selección y lifecycle. No incluye selectors, JS arbitrario, CDP, screenshots, inspección de red o acceso a credenciales. Se rechazan campos desconocidos. Cancelar/desconectar después de dispatch puede devolver `EXECUTION_UNKNOWN`: no se debe afirmar éxito ni repetir automáticamente.

La extensión pide exactamente **activeTab, scripting, nativeMessaging**. No pide tabs, debugger, storage, host_permissions, optional_host_permissions ni all_urls. Sólo consulta la pestaña activa al abrir/usar el popup para una aprobación explícita; no enumera pestañas privadas. La extensión no persiste grants. Un restart del backend, host o service worker invalida el acceso y requiere autorizar nuevamente; Chrome y sus pestañas permanecen abiertos.

## Instalación de desarrollo Windows (x64)

Prerequisitos: Chrome 120+ actualizado, Node 22.12+ y SDK .NET 8 (`dotnet --list-sdks`). No se requieren privilegios de administrador. Usá la misma cuenta Windows para Chrome y Atlas. La instalación es manual y explícita, nunca se ejecuta al iniciar Atlas.

1. En PowerShell, desde tu checkout:
   ```powershell
   git switch v0.5-browser-control
   git pull --ff-only origin v0.5-browser-control
   npm install
   npm run build
   ```
2. Dejá tu Chrome habitual abierto. En `chrome://extensions`, activá **Modo de desarrollador**, elegí **Cargar descomprimida** y seleccioná la carpeta absoluta `dist\extension` de este checkout.
3. Copiá el ID de **Atlas Browser Bridge** (32 letras a–p). Mantené la extensión y la ruta de carga; mover/eliminar/reinstalar un unpacked puede cambiar el ID. Antes de registrar el host verificá que el ID sea el que muestra Chrome. Si cambia, reinstalá el host con el ID nuevo; no uses wildcards en allowed_origins.
4. Ejecutá explícitamente:
   ```powershell
   .\scripts\install-browser-host.ps1 -ExtensionId "ID_DE_32_LETRAS"
   ```
   Usá la política de ejecución autorizada en tu equipo para scripts locales; Atlas no la modifica. El script publica un exe self-contained x64 en `%LOCALAPPDATA%\Atlas\BrowserBridge\0.5.1`, restringe la DACL del directorio a tu SID y SYSTEM y rechaza rutas reparse. No necesita .NET runtime adicional después de publicar.
5. Verificá el registro (no contiene secrets):
   ```powershell
   Get-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.atlas.browser_bridge'
   Get-Content "$env:LOCALAPPDATA\Atlas\BrowserBridge\com.atlas.browser_bridge.json"
   ```
   El valor por defecto es únicamente el path al manifest; `allowed_origins` contiene exactamente `chrome-extension://TU_ID/`. La configuración local del host sólo contiene ese ID.
6. En tu `.env` **local**, mantené tus configuraciones existentes y agregá:
   ```dotenv
   BROWSER_ENABLED=true
   BROWSER_PROVIDER=attached
   ATLAS_BROWSER_EXTENSION_ID=ID_DE_32_LETRAS
   ATLAS_BROWSER_HOST_PATH=C:\Users\TU_USUARIO\AppData\Local\Atlas\BrowserBridge\0.5.1\Atlas.NativeHost.exe
   BROWSER_TRACE=false
   ```
   Usá el path exacto que imprime el instalador. No copies estos valores al repo ni cambies OAuth. No hace falta BROWSER_PROFILE_DIR en attached. Dejá BROWSER_CONNECTION_ID vacío salvo selección explícita de múltiples conexiones.
7. Ejecutá `npm run dev`, abrí Atlas como siempre y conectá la voz. Fijá la extensión en la barra de Chrome. Abrí su popup: debería indicar **Conectado a Atlas**; el host reconecta con backoff hasta cinco segundos.
8. Pedí: **“Atlas, abrí YouTube y poné The Nights de Avicii.”** La pestaña puede abrirse antes del grant pero Atlas no observa su contenido. Con YouTube seleccionada, abrí el popup y revisá el origen, propósito y duración. Elegí **Permitir pestaña actual**. Atlas debe continuar con una observación nueva, sin volver a abrir YouTube ni afirmar que ya reprodujo el tema.
9. Si el sitio exige un gesto real, un control no soportado o autenticación, intervení manualmente y decí **“listo”** cuando terminaste. Atlas verifica el handoff y vuelve a observar. No transforma “listo” en aprobación de una acción sensible.

## Acceso, revocación y navegación

Para una pestaña existente: seleccioná la pestaña de trabajo y pedí a Atlas acceso a la pestaña actual para la tarea. Abrí el popup y aprobá el origen mostrado. El modelo no recibe el título/contenido de otras pestañas. Por defecto el acceso dura hasta fin de tarea o **15 min**, lo que ocurra primero. El acceso de **sesión (30 min)** debe solicitarse explícitamente; no se renueva automáticamente. Al terminar, Atlas dispone de `browser.endTask`; también podés revocar inmediatamente en el popup o con `browser.revokeAccess`.

En navegación del mismo origen, los refs anteriores quedan invalidados y se exige otra observación. Al cambiar de origen, activeTab deja de permitir inyección: el proveedor se detiene con `ORIGIN_PERMISSION`. Seleccioná esa pestaña, abrí el popup y elegí **Renovar origen**; cambia el origen autorizado sin extender la expiración. No renueva un CAPTCHA/MFA por accidente. Reiniciar Atlas o desconectar voz termina los grants de la sesión, no cierra Chrome ni sus tabs. La operación `browser.close` no se ofrece en attached: cerrar trabajo personal con cambios sin guardar queda manual.

`ACCESS_PENDING` autoriza una pestaña; `REQUIRES_USER_INTERACTION` pausa automatización; las confirmaciones consecuenciales existentes siguen siendo otra autoridad. Ninguna aprobación del popup ni “listo” aprueba Calendar/Gmail/Memory ni una acción sensible. V0.5.1 **no ofrece clicks DOM consecuenciales genéricos**, ni siquiera mediante un grant.

## Observación y controles

Content scripts empaquetados, sin eval/JS recibido, se inyectan en el mundo aislado del frame principal sólo tras autorización. La observación compacta devuelve hasta 40 controles visibles (~10 KB), prioriza el modal visible y no devuelve valores de inputs ni full DOM. Excluye password/OTP/card controls, limita y redacta nombres y URLs (sin query). Los refs son UUIDs ligados a scope/tab/document/snapshot, TTL 15 s, consumidos antes de actuar e invalidados por cambios DOM, navegación/reload/revoke/reconnect. Una página dinámica puede exigir observar de nuevo por `STALE_REF`.

La superficie permite navegación validada, búsqueda, rechazo de tracking opcional/aceptación de cookies necesarias y media HTML. Accept-all/marketing/privacy settings, publicaciones, pagos y otros controles quedan bloqueados. Campos genéricos, controles custom, frames cruzados y formularios no-GET requieren intervención. Eventos sintéticos no equivalen a input confiable de usuario; no se garantiza controlar todos los reproductores/buscadores de YouTube o aplicaciones Notion. Notion autenticado puede probarse para navegación visible segura; no se habilita edición/publicación para superar el test.

CAPTCHA, AUTHENTICATION, MFA, CHALLENGE, ORIGIN_PERMISSION, UNSUPPORTED_CONTROL y MEDIA_USER_GESTURE generan un handoff UUID. Atlas no resuelve CAPTCHA/MFA ni usa stealth. La detección es conservadora y no exhaustiva; un challenge nuevo/custom puede requerir intervención manual aunque no sea detectado automáticamente.

## Seguridad y límites

- Backend conserva validación, registry, READ/reversible/consequential, ejecución central y confirmaciones existentes. La extensión aplica además comandos allowlist, scope, deadline, epoch y refs.
- Contenido web es dato no confiable, nunca instrucciones. Labels pueden mentir: la clasificación DOM conservadora reduce superficie, pero no puede demostrar ausencia de consecuencias ocultas en una página maliciosa. Usá scopes breves sólo en sitios de confianza; revocá cuando termina la tarea.
- Una extensión comprometida puede abusar de los permisos que Chrome le concede. El backend no convierte sus respuestas en aprobación sensible. Malware del mismo usuario está fuera de la frontera del pipe/DACL; no se promete proteger de un equipo comprometido.
- No hay inspección indiscriminada ni importación del perfil a Memory. Las observaciones necesarias llegan al contexto de la tarea, igual que otros resultados de tools; no contienen credenciales intencionalmente. No uses tabs con secretos visibles que no querés compartir con Atlas.
- El transporte no ejecuta shells por mensaje, no lee el perfil y no expone CDP/HTTP de control. No se aumentaron timeouts globales ni se trasladaron bloqueos de red aislada a Chrome personal.

## Troubleshooting, actualización y uninstall

- **No conectado:** comprobá ID exacto, manifest HKCU, exe existente, misma cuenta y Atlas iniciado con attached. Revisá errores del service worker en chrome://extensions. No compartas DOM, URLs privadas ni payloads; `BROWSER_TRACE=true` opcional sólo genera diagnostics sanitizados de Atlas.
- **Más de un Chrome conectado:** `browser.status` devuelve UUIDs de conexión, sin nombres/perfiles/pestañas privadas. No se elige arbitrariamente: configurá `BROWSER_CONNECTION_ID` con la conexión deseada y reiniciá Atlas. Es un ID efímero y debe revisarse tras reconexión; cerrar ventanas ajenas no es una solución automática.
- **Origen/control no soportado:** seleccioná la tab, usá el popup para renovar origen si corresponde o completá manualmente. “listo” sólo re-observa el handoff vigente. Si hay una confirmación sensible pendiente, resolvela/rechazala por su flujo propio antes de reanudar.
- **EXECUTION_UNKNOWN:** revisá manualmente qué ocurrió. No repitas automáticamente una operación incierta.
- **Actualizar este build de desarrollo:** detené Atlas, deshabilitá la extensión, ejecutá uninstall, `git pull --ff-only`, `npm install`, `npm run build`, recargá la extensión, verificá el ID y repetí install. El instalador rechaza sobrescribir una versión existente.
- **Desinstalar:** detené Atlas y deshabilitá/eliminá la extensión en chrome://extensions; ejecutá `.\scripts\uninstall-browser-host.ps1` desde PowerShell. Elimina sólo la key HKCU y la instalación Atlas. No mata Chrome ni borra su perfil. Volvé a `BROWSER_PROVIDER=isolated` si querés el sandbox.

## Acceptance Windows A–L (registrar resultado, no asumir aprobado)

A. Dejá Chrome habitual abierto y autenticado. `browser.status` muestra conexión; antes de aprobar `browser.tabs` no muestra tabs privadas.

B. Solicitá una tab actual, autorizá desde popup y verificá sólo esa tab. Rechazar/cancelar no concede acceso. Comprobá scopes tarea y sesión.

C. Pedí “abrí YouTube y poné The Nights de Avicii”. Grant claro, búsqueda/refs nuevas y media; si un control requiere gesto real, handoff explícito y operación manual, nunca éxito inventado.

D. Con Notion ya autenticado, concedé esa tab y pedí navegación/observación segura. No pedir OAuth, copiar perfil ni re-login salvo que el propio sitio lo requiera. Controles de edición permanecen manuales/bloqueados.

E. Reiniciá Atlas; Chrome y tabs siguen abiertos. Refs/grants anteriores no sirven; nueva sesión requiere permiso.

F. Deshabilitá/habilitá la extensión y reconectá: epoch nuevo, acceso nuevamente, sin replay automático ni tabs cerradas.

G. Revocá en popup; el siguiente observe/click falla y la tab sigue abierta.

H. Intentá reutilizar ref después de 15 s, navegación, cambio DOM o reload: falla sin acción; una observación nueva permite sólo refs vigentes.

I. Challenge real o fixture: `REQUIRES_USER_INTERACTION`, no clicks al CAPTCHA, usuario interviene y “listo” re-observa; challenge persistente permanece detenido.

J. Un botón delete/send/purchase de una fixture debe estar bloqueado. Una acción consecuencial de Calendar/Gmail sigue requiriendo su confirmación actual; aprobar tab/decir “listo” no ejecuta esa acción. No se amplía DOM para hacer pasar J.

K. Inspeccioná manifest y código empaquetado: sólo tres permisos, sin cookies/storage/auth headers/password getters/profile/network APIs; tests usan sentinels. No pongas secretos reales en fixtures ni logs.

L. Con otra tab no autorizada abierta, pedí list/observe: nunca debe aparecer su contenido ni título. Navegación cross-origin en la tab concedida se detiene y exige nuevo gesto/popup.

## Validación automatizada

`npm run typecheck`, `npm test` (pretest compila extensión), `npm run build`, `git diff --check`.
Para el test opcional de procesos Native Messaging, compilá primero el proyecto .NET y configurá `ATLAS_NATIVE_TEST_BINARY` con el apphost binario. En Windows:

```powershell
dotnet build .\native\Atlas.BrowserHost\Atlas.BrowserHost.csproj -c Release
$env:ATLAS_NATIVE_TEST_BINARY = (Resolve-Path .\native\Atlas.BrowserHost\bin\Release\net8.0\Atlas.NativeHost.exe).Path
npm test
Remove-Item Env:ATLAS_NATIVE_TEST_BINARY
```

Sin esa variable, el test Native informa skip explícito. Los tests POSIX/Windows condicionales mantienen sus límites; ni los mocks de Chrome ni Chromium con fixtures sustituyen A–L real.
