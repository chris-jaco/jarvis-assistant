# Atlas Companion para Android · prueba de desarrollo

Aplicación independiente para hablar en primer plano. El inicio es manual. El micrófono y el audio remoto usan una sola conexión WebRTC. El servidor Realtime recibe la voz. El emisor USB sólo autoriza la apertura de una sesión, sin herramientas ni acceso a memoria. El usuario puede interrumpir hablando mientras Atlas responde. Al salir de primer plano, perder la ruta de auriculares o perder foco de audio se debe cerrar la sesión. Volver requiere una acción explícita.

## Compilación en un PC de desarrollo

Desde `mobile` en la rama `spike/android-companion`. Usar Node 24, JDK 17 disponible para Gradle y el SDK Android instalado. La plantilla Expo fijada evita regenerar Gradle con una versión de React Native distinta. En PowerShell:

```powershell
npm ci
npm test
npm run typecheck
npm run bundle
New-Item -ItemType Directory -Force .template | Out-Null
npm pack expo-template-bare-minimum@56.0.38 --pack-destination .template
npx --no-install expo prebuild --platform android --no-install --template .template/expo-template-bare-minimum-56.0.38.tgz
Push-Location android
.\gradlew.bat :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
Pop-Location
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb reverse tcp:8765 tcp:8765
npm start
```

La variante indicada es para un teléfono ARM64. En el teléfono autorizar sólo la PC conocida para depuración USB. Usar una sola unidad conectada o seleccionar el dispositivo con `adb -s SERIAL`. Abrir Atlas Companion y conectar el development client al Metro local en `http://127.0.0.1:8081`. La primera vez puede ser necesario introducir esa URL en la pantalla de desarrollo. Mantener Metro en localhost. El plugin local fija EX_DEV_CLIENT_NETWORK_INSPECTOR=false en Gradle. Mantener cerrados los demás depuradores de red y desactivar grabación de pantalla y transcripción de terminal al usar una credencial real.

| Componente | Versión | Motivo |
|---|---|---|
| Expo / dev-client | 56.0.24 / 56.0.28 | Development build con módulos Android |
| React / React Native | 19.2.3 / 0.85.3 | Par de la plantilla SDK 56 |
| react-native-webrtc / config plugin | 124.0.7 / 15.0.2 | Audio dúplex, SDP y configuración nativa. La matriz del plugin incluye SDK 56 |
| Módulo local AtlasAudioRoute | Código Kotlin del spike | Solicita foco, selecciona una ruta de comunicación y reacciona a su pérdida |
| Toolchain | Platform 36, Build Tools 36.0.0, NDK 27.1.12297006; Gradle del wrapper | Expo Modules y React Native incluyen targets CMake/C++. JDK 17 requerido por el plugin RN |

En Linux se prepararon fuera del repositorio Command-line Tools 23.0, Platform 36 rev. 2, Platform Tools 37.0.3, Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1 y Gradle 9.3.1. El JDK fue Temurin 17.0.21.1+2 para Linux x64, SHA-256 `0b0ac5eab6db6abaec68c9913bcddb31321e5da411c45073d520d9c125e6f7b4`. Se verificó la firma con el fingerprint oficial `3B04D753C9050D9A5D343F39843C48A565F8F04B`. La selección de Java y el truststore del sistema fueron específicos del proceso Gradle. [Release Temurin](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.21.1%2B2) · [Verificación Adoptium](https://adoptium.net/installation/gpg-verification)

El lockfile del móvil fija las transitivas npm. TypeScript usa la resolución de subrutas clásica para los tipos del shim de eventos de WebRTC. Metro puede avisar que `event-target-shim/index` requiere su fallback de resolución. Confirmar autolinking y el manifiesto **fusionado de debug** en cada build. El template debug declara overlay para las herramientas de desarrollo; la app no necesita concederlo. La configuración principal bloquea cámara, almacenamiento externo y servicio de micrófono. Se pide RECORD_AUDIO al iniciar y BLUETOOTH_CONNECT al elegir auriculares desde Android 12. Registrar sólo versión Android, ruta usada por categoría y resultado. Evitar identificadores, tokens o trazas de tráfico.

## Emisor local de desarrollo

La clave principal se introduce únicamente en otra terminal de la PC de desarrollo. Usar una clave de prueba separada. El proceso sólo escucha en 127.0.0.1 y entrega una credencial efímera por ensayo. El código de ocho dígitos se muestra sólo en una terminal interactiva durante un máximo de 60 segundos. Cada conexión puede consumir crédito de OpenAI. La prueba requiere autorización del operador. Desde `mobile`, en PowerShell 7:

```powershell
$secure = Read-Host 'Clave OpenAI del proyecto de prueba' -AsSecureString
$env:ATLAS_ANDROID_DEV_OPENAI_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
try { node --experimental-strip-types tools/issuer.mjs }
finally { Remove-Item Env:ATLAS_ANDROID_DEV_OPENAI_KEY; $secure.Dispose() }
```

Ingresar el código en el teléfono, elegir micrófono o auriculares y pulsar **Hablar con Atlas**. El emisor comprueba el código una vez antes de solicitar la credencial efímera. El teléfono envía la oferta SDP al proveedor y libera el micrófono con **Finalizar**. Repetir el emisor para otra conversación. Al terminar:

```powershell
adb reverse --remove tcp:8765
adb reverse --remove tcp:8081
```

## Aceptación física

1. Con micrófono del teléfono, denegar el permiso. Verificar salida limpia. Concederlo explícitamente e iniciar otra sesión. Hacer diez turnos y cinco interrupciones. Comprobar audio bidireccional, claridad y tiempo hasta el silencio de la respuesta interrumpida.
2. En Android 12 o posterior, conectar auriculares emparejados para llamadas y elegir Bluetooth. Separar el teléfono de la boca y comprobar con el oyente el micrófono realmente utilizado. Repetir diez turnos, cambiar de ruta y desconectar los auriculares durante una respuesta. Verificar cierre y ausencia de audio inesperado por altavoz.
3. Cortar red durante inicio y conversación. Probar recibir una llamada, salir a otra app, bloquear pantalla y pulsar Finalizar durante la conexión. Confirmar indicador del micrófono apagado, sin reanudación al volver ni duplicación al tocar dos veces. Repetir tras reinicio del proceso. Anotar teléfono, versión, perfil de auriculares y resultado sin identificar el dispositivo.
4. En V0.7 el bloqueo de pantalla **finaliza** la sesión. Para continuar en bolsillo haría falta iniciar un servicio foreground de tipo microphone mientras la actividad es visible, notificación persistente con Stop, foco, política de llamadas y recuperación explícita. Android 14+ restringe el permiso durante el uso y Android 15+ condiciona el foco a actividad visible o servicio foreground. Evaluar en un spike separado de 30 minutos con pantalla bloqueada, con batería normal y ahorro de batería. Comparar batería, pérdidas de audio y liberación al terminar. [Restricciones Android](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) · [Audio focus](https://developer.android.com/media/optimize/audio-focus)

Sólo aceptar primer plano tras pasar las pruebas físicas. Si WebRTC no mantiene ruta/foco en el dispositivo, conservar las mediciones y evaluar Kotlin nativo antes de portar más UI. React Native reutiliza contratos TypeScript; Capacitor depende del comportamiento de audio del WebView y Flutter requiere otro cliente. El diseño de herramientas y memoria con PC apagada está en [REMOTE-CORE.md](REMOTE-CORE.md).

## Resultado de compilación del sprint en Linux

Pasaron el typecheck, las siete pruebas sintéticas de sesión/emisor/contratos, el bundle Android Hermes y la generación nativa con la plantilla 56.0.38. El autolinking identificó AtlasAudioRoute. Gradle seleccionó Temurin 17, la plataforma 36 y el NDK fijado. Durante la resolución también instaló Build Tools 35.0.0 por requerimiento del grafo de dependencias.

`:app:assembleDebug` se detuvo en `:app:checkDebugAarMetadata`. La descarga de `com.facebook.react:react-android:0.85.3` desde Maven Central redirigió a `https://repo.reactnative.dev/maven2/com/facebook/react/react-android/0.85.3/react-android-0.85.3-debug.aar` y recibió HTTP 403. Los metadatos Gradle de la versión declaran 267296510 bytes y SHA-256 `5a6aca319339127b70c97bcfae61a9cfe59bcfd217420267f884e8410074f556`. Ese valor permite verificar el AAR oficial cuando esté disponible. Se requiere acceso al artefacto para completar la compilación nativa y obtener un APK instalable. El bundle JS por sí solo no ejecuta el módulo Kotlin ni acredita WebRTC o Bluetooth.

La dependencia Android del wrapper WebRTC utiliza `org.jitsi:webrtc:124.+`. Registrar el artefacto Maven efectivamente resuelto (además del lockfile npm) junto al APK de prueba. Antes de instalarlo, revisar permisos finales con Android Studio APK Analyzer o `apkanalyzer manifest permissions` y comprobar la firma con `apksigner verify --print-certs`. Instalar sólo en el dispositivo de desarrollo autorizado.
