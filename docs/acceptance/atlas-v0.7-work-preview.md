# Atlas Desktop Work Preview · aceptación personal en Windows 11

Candidato de código `0.7.0-preview.1`, iniciado en el tag `v0.6.2`. La aceptación de ese tag es la referencia para voz, memoria y Tray. El resultado de esta ficha debe registrarse en Windows con el candidato exacto. Usar cuentas de prueba y pedir permiso antes de cualquier operación externa.

## Generar y abrir el paquete

Desde el árbol V0.7 revisado, en PowerShell con Node 22.12 o posterior:

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Falló la restauración del lockfile' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Falló la suite' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Falló el typecheck' }
npm run desktop:package:win
if ($LASTEXITCODE -ne 0) { throw 'Falló el empaquetado' }
npm run desktop:verify-package
if ($LASTEXITCODE -ne 0) { throw 'Falló el verificador' }
Get-FileHash .\release\win-unpacked\resources\app.asar -Algorithm SHA256
Get-FileHash .\release\win-unpacked\Atlas.exe -Algorithm SHA256
```

Copiar la carpeta **completa** a una ubicación nueva de tu usuario. Abrir `Atlas.exe` ahí con el repositorio y VS Code cerrados. La copia de ejecución incluye Chromium, las DLL y ASAR. El uso cotidiano no requiere Node. Para actualizar, elegir **Salir de Atlas**, esperar el cierre de Core y de los procesos de esa copia, y extraer la siguiente versión en otra carpeta. Si queda un proceso o hay dudas, posponer el reemplazo. Para quitar el programa cerrar del mismo modo y eliminar únicamente esa carpeta. Conservar userData para mantener credenciales y memoria; su eliminación sería otra decisión explícita. Distribución personal en carpeta, sin firma, instalador ni actualizador.

## Configurar Google

1. Completar la configuración de la API key OpenAI en la ventana privada. Preparar un cliente OAuth de tipo **Aplicación de escritorio** de tu proyecto Google, con las APIs Gmail y Calendar habilitadas y la cuenta de prueba autorizada en la pantalla de consentimiento. Guardar el JSON original en una ubicación privada fuera del paquete.
2. En la primera configuración, o desde **Atlas → Gmail y Calendar… (reiniciar Atlas)**, elegir **Importar cliente OAuth**. El selector nativo lee el JSON en Main y el almacén guarda el par cifrado mediante safeStorage. La gestión ocurre antes de iniciar Core para evitar que una renovación en vuelo restaure un token retirado. Seleccionar **Continuar a Atlas** para iniciar Core con una generación nueva.
3. Elegir **Conectar**, el servicio y la cuenta en el navegador del sistema. Comprobar el nombre de la aplicación y los permisos antes de aceptar. El callback único usa loopback, PKCE S256, state y caducidad. Gmail permite varias cuentas y verifica la identidad con ID token y perfil. Calendar utiliza un token por perfil de Atlas: conectar otra cuenta reemplaza la autorización de Calendar.
4. Seleccionar **Verificar conexión** para cada servicio. Una respuesta verificada corresponde al token, audiencia, scopes y vigencia observados en ese momento. Un error de red queda como no verificable. La consulta posterior de Gmail o Calendar comprueba además acceso al servicio. **Desconectar** quita el token local elegido. Para revocar el permiso en Google, hacerlo también en la página de seguridad de la cuenta.
5. Diferenciar almacenamiento. La clave OpenAI y el cliente OAuth se cifran. Los tokens OAuth de usuario se guardan en archivos con ACL privadas. La memoria semántica también es local. El audio conversacional y los resultados usados en una conversación pueden llegar a OpenAI; la extracción de memoria habilitada también usa el proveedor. Google recibe las solicitudes OAuth y las operaciones aprobadas de cada adapter. Mantener los datos personales fuera de informes, capturas y logs.

## Casos a registrar como PASS, FAIL o pendiente

| Caso | Observación necesaria |
|---|---|
| Primer inicio sin Google | El orbe inicia y termina voz. Un archivo cancelado o incompatible no cambia el cliente OAuth. |
| Conexión y reinicio | Conectar ambos servicios, verificar y reiniciar. Una segunda cuenta Gmail se distingue por identidad. Probar denegación del consentimiento y callback ocupado; los errores no muestran secretos. |
| Lectura | Buscar correo de prueba, abrir mensaje e hilo; consultar agenda y disponibilidad en la zona elegida. Contrastar los resultados con las cuentas de prueba. |
| Borrador, envío y respuesta | Crear y editar borrador. Revisar cuenta, remitente, destinatario y contenido antes de confirmar. Rechazo/caducidad dejan cero envíos. Un envío real requiere autorización específica. Ante resultado incierto, comprobar Enviados sin reintento automático. La protección en memoria contra duplicados termina con el proceso. |
| Agenda | Crear cita en zona explícita, agregar invitados de prueba, verificar actualización, conflicto de etag y rechazo. Antes de eliminar un evento debe explicarse que Atlas no solicitará avisos a invitados. Confirmar sólo la ocurrencia mostrada. |
| Credenciales | Desconectar exactamente una cuenta Gmail y Calendar, reiniciar y verificar que desaparecen sus accesos. Revocar en Google con cuenta de prueba y comprobar que Atlas no anuncia una conexión verificada. |
| Voz y lifecycle | Interrumpir hablando, perder red, reconectar explícitamente. Ocultar cierra la voz, restaurar queda desconectado, minimizar conserva la sesión. Probar Tray, cierre explícito y reinicio conservando configuración. |
| Aislamiento | Ninguna clave o token aparece en renderer principal, argumentos, estado o errores. No registrar contenido de correo, audio, citas o credenciales. El verificador de ASAR debe pasar sobre la misma carpeta entregada. |

Registrar versión Windows, hash de EXE y ASAR, filas pasadas y fallidas, sin adjuntar userData. Aceptar la preview personal únicamente al completar los casos aplicables con el paquete real. El APK Android y la investigación vocal tienen aceptaciones separadas.
