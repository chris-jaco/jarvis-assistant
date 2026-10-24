# Native Live experimental — Windows x64

Evaluación personal aislada de sherpa-onnx 2.0.0. No integra Atlas, Electron,
Realtime, Core, Tray ni lifecycle. Warm Live WASM sigue sin aceptación. Las cifras
Offline comunicadas por el propietario justifican esta prueba; no prueban Live.
No hay permiso para distribuir los pesos de licencia aún no verificada.

Desde Hito 1.4, la [calibración de sensibilidad](NATIVE-SENSITIVITY.md) permite
--threshold .25/.15/.10/.05 con escritura decimal completa (por ejemplo 0.15).
El valor por defecto, los comandos anteriores y el replay siguen siendo .25.
El contrato añade evidencia float32 y hash de keyword específico del umbral;
requiere recompilar y generar un lock nuevo. No cambian otros parámetros ni audio.

## Arquitectura y límites

- Un proceso por ensayo. El hilo de inferencia crea y posee spotter/stream.
  COLD usa un stream inicial nuevo. WARM procesa silencio hasta dos Decode,
  máximo 30 bloques/10 s entre llamadas; crea otro stream antes de destruir el
  anterior, comprueba identidad distinta y reinicia contadores. Sólo entonces
  puede comenzar la captura. Esto verifica recreación por API, no calentamiento
  interno completo de kernels/estados.
- Otro hilo usa WASAPI compartido, endpoint de captura predeterminado eConsole,
  GetMixFormat e Initialize con ese mismo formato, sin AUTOCONVERTPCM. No obtiene
  nombres/IDs de dispositivos. Windows debe permitir micrófono a aplicaciones
  de escritorio; un fallo bloquea la prueba, sin elevación ni cambio de permisos.
- Captura y DSP nunca llaman al decoder. Una cola SPSC de cuatro bloques de
  1600 float32 conecta los hilos. push no espera al consumidor. Hay además un
  bloque en inferencia y otro en ensamblado: hasta **38400 bytes de PCM** propios
  para esos seis bloques, más historia FIR y el buffer WASAPI del sistema.
  No es el pool de cuatro buffers WASM, que permanece intacto.
- El buffer WASAPI se acepta sólo si mide como máximo un segundo. Formatos:
  PCM16/24/32 o float32/64 intercalados, hasta ocho canales; tasas 16/32/44.1/48/
  88.2/96/176.4/192 kHz. Un formato diferente se rechaza antes de Start.
  containerBits y validBits se registran; PCM válido alineado a la izquierda se
  escala según su contenedor. No hay ganancia, downmix ni normalización adicional.
- Se mide RMS, peak, clipping y nearZero de **cada canal**, pero se selecciona
  explícitamente el canal 0. No se cambia automáticamente ante señal baja.
  El formato observado es el del cliente/mixer WASAPI, no una prueba de la tasa
  física del ADC. DSP/enhancements del dispositivo o Windows pueden diferir del
  navegador; no se afirma haberlos deshabilitado.
- Resampler causal FIR Blackman-sinc, cutoff 7200 Hz, fases racionales,
  `128 * ceil(inputRate/16000) + 1` taps. Estado continuo entre paquetes. Emite
  exactamente `floor(framesConvertidos * 16000 / inputRate)` muestras. En 16 kHz
  omite el FIR y conserva los bits, incluido cero negativo. A 48 kHz: 385 taps,
  retardo de grupo de 4 ms. Coeficientes calculados una vez, antes de Start.
  La invariancia bit a bit se prueba frente a fragmentaciones distintas dentro
  del mismo build; no se promete identidad transcendental entre compiladores.
- El estado FIR inicial es cero; **no añade frames de silencio** al audio.
  No se vacía la cola del filtro con padding al finalizar: hay un transitorio
  inicial y el final no incorpora la respuesta posterior del FIR. Registrar este
  retardo y no interpretar el borde de Stop como una palabra completa garantizada.
- DATA_DISCONTINUITY en el primer paquete se registra por separado: aún no hay
  historia anterior para comparar. No demuestra ausencia de pérdida antes del
  primer paquete; requiere revisar ese inicio en Windows. Cualquier discontinuidad
  posterior, salto de posición o timestamp inválido detiene la prueba. El flag
  SILENT representa muestras cero entregadas por WASAPI y se contabiliza aparte.
- Overflow no descarta para seguir: detiene captura y marca FAILED. framesReceived,
  framesConverted, unconvertedFrames y unprocessedSamples muestran lo que quedó
  sin procesar. Los bloques abandonados se cuentan antes de limpiar la cola.

## Preparación local y compilación

En cloud faltan manifiesto, pesos, tokens y WAV, además de MSVC/Windows. No se
descarga ni instala nada. La compilación y el hardware se validan en Windows.

Desde la raíz del repositorio, en **Developer PowerShell x64** con MSVC ya instalado:

```powershell
$sdk = (Resolve-Path '.local\wake-word-spike\native-sdk\v2.0.0-win-x64-shared-MD-Release-no-tts-audit\extracted\sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts').Path
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-live'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'NATIVE_LIVE_BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock WARM 60 --check
if ($LASTEXITCODE -ne 0) { throw 'NATIVE_LIVE_PREFLIGHT_FAILED' }
```

La carpeta de salida debe ser nueva. Se usan C++17, x64, /O2 /MD /utf-8,
SHERPA_ONNX_BUILD_SHARED_LIBS, Windows 10+ SDK, C API import library y las DLL
auditadas app-local. ole32/uuid/bcrypt/psapi son bibliotecas del SDK Windows,
no nuevas dependencias de Atlas. No se ejecutan los EXE incluidos en sherpa.

Se mantienen versión 2.0.0, commit
`8abb7c8f87eae85b2e75f9a4115236c978980add` y artefacto SHA-256
`98d8cf1c0e0bfb5768042e90ffe9591203855b8f4aabdcd5c154eb39b87a0707`.
El helper verifica header/lib/DLL y genera un lock de EXE y de las tres fuentes.
El supervisor verifica otra vez hashes, manifiesto/modelos/tokens y keyword exacta;
el ejecutable verifica las DLL realmente cargadas y la versión antes de crear el
modelo. Sin firma del EXE compilado: usar una carpeta local privada y estable.
Al modificar fuentes hay que recompilar; nunca editar un lock para ignorar el fallo.

El adaptador Offline sólo cambió para poder incluir sus helpers bajo una macro
de biblioteca; Feed y los parámetros permanecen iguales. Ese cambio invalida el
lock fuente del benchmark Offline anterior: recompilarlo en una carpeta nueva
con el mismo helper **sin -Live** antes de volver a ejecutarlo.

## Ejecutar y detener

```powershell
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 |
  Set-Content -Encoding utf8 (Join-Path $out 'cold-s1.json')
$trialExit = $LASTEXITCODE
node --import tsx experiments/wake-word/native-live.ts $exe $lock WARM 60 --detail |
  Set-Content -Encoding utf8 (Join-Path $out 'warm-s1-detail.json')
$trialExit = $LASTEXITCODE
```

Duración permitida: 1–120 s; sólo ensayos de al menos 60 s cuentan para aceptación.
Esperar **CAPTURE_STARTED** en stderr para comenzar los intentos. PREPARING señala
la preparación sintética. stdout contiene un único JSON. --detail agrega arrays
numéricos acotados; no agrega PCM. Los JSON sólo se guardan por redirección explícita.
No guardar nombres/IDs de dispositivo en los reportes compartidos: anotar un alias
local para mantener condiciones entre ensayos.

Enter o Ctrl+C solicita Stop cooperativo. No se reintenta ni se reinicia. Se deja
de capturar, se liberan interfaces WASAPI/COM, se procesan los bloques reales ya
aceptados y el bloque final parcial, sin padding, y se libera el motor. Cada
siguiente ejecución es un Start nuevo con stream, FIR y cola limpios.

Salida 0: terminó la captura solicitada con contabilidad íntegra; **no es PASS
acústico ni autorización de integración**. Salida 130: CANCELLED/incompleta.
Salida 2: fallo. Un ensayo con error, Stop temprano o timeout nunca es PASS.

Un Decode síncrono no se puede interrumpir con seguridad dentro de la DLL.
La captura tiene su propio Stop y libera el micrófono mientras el decoder termina.
El supervisor tiene límite global `duración + 60 s`; primero solicita Stop y, si
no retorna en 5 s, termina **sólo su hijo experimental** y devuelve timeout sin
afirmar cleanup. No termina Atlas ni otros procesos. Un cierre forzado del terminal,
fallo del driver o proceso abortado externamente requiere comprobar liberación en
Windows; no hay garantía de reporte final ante esas situaciones.

## Contrato JSON

Schema 1, backend NATIVE_LIVE, source MICROPHONE o REPLAY, mode COLD/WARM,
state COMPLETED/CANCELLED/FAILED y code cerrado. No errores crudos, rutas,
argumentos, nombres de dispositivo, tokens reconocidos ni transcripciones.

| Campo | Contenido y alcance |
|---|---|
| runtime/modelHashes/keywordSha256/configuration | Identidad verificada; .25, score 1, beam 4, cooldown 1000 ms, 16 kHz mono, feature dim 80, trailing blanks 1 |
| format/conversion/channels | Mixer efectivo, canal 0, FIR/retardo, RMS/peak por canal y salida, clipping, nearZero |
| capture | Pared desde Start hasta Stop, frames y muestras recibidas/convertidas/procesadas, bloques completos y parcial, overflow/discontinuidades/errores |
| buffer | Cuatro slots en espera, highWater, abandonados por fallo, pendientes después de limpiar, máxima edad y latencia del bloque |
| preparation | Inicialización, silencio sintético, llamadas Warm, tiempo/reset y stream nuevo comprobado |
| inference | Primera Decode, mediana/p95/máximo, máximo bloque, suma de pared de procesamiento, CPU del hilo durante procesamiento, RTF, llamadas |
| recognition/positions | RawHits/detecciones/supresiones, bloque y sampleEnd, startTime/timestamps del decoder, completitud del bloque |
| memory | Working Set y pico del proceso, memoria tras cleanup, máximos en ventanas de diez segundos de audio; null si no disponible/no observado |
| cleanup | Liberación de micrófono/COM/motor, joins, tiempo de join/limpieza y tiempos de liberación individuales; null cuando no se midieron |
| details | Opcional: Decode y bloques numéricos; límites 10000 llamadas, 1300 bloques, 1000 hits |

QPC mide pared, GetThreadTimes CPU kernel+user del hilo que llama al decoder.
**No es CPU total del proceso** ni incluye necesariamente otros hilos ONNX.
Pared menos CPU no demuestra por sí sola desplanificación.
RTF = suma de pared de procesamiento / duración nominal de las muestras procesadas;
no incluye espera por micrófono, carga ni Warm.

La edad de cola y latencyFromBlockEndMs usan timestamps WASAPI expresados en QPC,
corregidos por retardo FIR (aproximación de hasta un frame de entrada, más precisión
del driver). Miden desde la última muestra del bloque, **no desde el final real de
la palabra**. acousticLatencyMs siempre es null. Los timestamps del decoder se
conservan sin reinterpretar como posiciones globales tras resets.

technicalThresholdsMet sólo verifica criterios numéricos iniciales de un ensayo
MICROPHONE completo >=60 s: primera Decode/máximo bloque <200 ms, RTF <.7, sin
errores de continuidad/cola y con recursos liberados. acceptance siempre exige
MANUAL_REVIEW_REQUIRED: memoria sostenida y precisión requieren evaluación humana.

## Replay exacto y comparación

```powershell
$wav = (Resolve-Path '.local\wake-word-spike\audio\atlas-autorizado.wav').Path
node --import tsx experiments/wake-word/native-live.ts $exe $lock WARM 60 --replay $wav |
  Set-Content -Encoding utf8 (Join-Path $out 'replay-warm.json')
if ($LASTEXITCODE -ne 0) { throw 'NATIVE_LIVE_REPLAY_FAILED' }
```

No abre micrófono: valida PCM16 mono/16 kHz, SHA WAV y PCM fijado
`ddd500ae3b79de9fa1f9af82c04142dfd1b06dd2fca5237008f0cd3af3b5138b`.
Alimenta 330411 muestras en bloques de 1600, último de 811, a ritmo nominal por la
cola Native; termina al EOF, no espera los 60 s. No añade silencio. El bypass a
16 kHz conserva PCM. processedPcmSha256 se calcula incrementalmente sobre los
bloques reales justo antes de Feed y debe coincidir; no se calcula hash del
audio del micrófono. Ese hash de replay queda fuera del tiempo de Feed medido. Después ejecuta WASM Offline en otro proceso con ese WAV y
el mismo modo. Compara hashes, parámetros, 207 bloques, 3 hits en 27/46/91, 64 Decode,
calendario y posiciones exactas. Cualquier discrepancia bloquea equivalencia.
Los contadores se validan antes de comparar; no se cambian parámetros ni modelos.

Son cuatro resultados distintos: benchmark Offline, Native Live, WASM Live y
replay con PCM idéntico. Comparar capturas reales bajo condiciones equivalentes
**no demuestra** equivalencia exacta. Las revisiones de runtime y los stacks son
distintos; no atribuir automáticamente toda diferencia a Native/WASM.

## Matriz de aceptación Windows pendiente

| Ensayo | Cold | Warm | Condiciones |
|---|---:|---:|---|
| Silencio >=60 s | 3 | 3 | Mismo alias de dispositivo, distancia y entorno; registrar falsos positivos |
| Voz >=60 s | 3 | 3 | Aproximadamente 20 «Atlas» por ensayo, contar intentos reales y anotar falsos negativos |
| Stop/Start | 3 | 3 | Stop durante captura, verificar liberación; Start nuevo debe completar 60 s sin residuos |

Ejecutar secuencialmente y guardar cada JSON con nombre distinto bajo .local.
No contar la parte cancelada de Stop/Start como ensayo completo. Registrar idioma,
distancia, ruido, formato, versión Windows/runtime, plan energético y configuración;
no modificar reconocimiento ni aplicar ganancia para mejorar resultados.

Requiere cero overruns, saltos no justificados, errores de secuencia y descartes
ocultos; contabilidad de muestras y cola exacta, cleanup completo, ausencia de
acumulación progresiva y de crecimiento sostenido de memoria, primera Decode y
máximo bloque <200 ms, RTF <.7. Revisar ventanas de memoria y diagnóstico detallado;
un pico único/ensayo corto no acredita estabilidad. Confirmar que el indicador de
micrófono Windows se libera y otra aplicación puede abrirlo después de Stop/error.
Observar también el proceso experimental durante escucha: no deben existir
conexiones de red ni archivos de audio nuevos. La ausencia de APIs de red en el
harness no sustituye esa observación del runtime/SDK en Windows.
Probar además micrófono denegado/desconectado, formato no soportado, cancelación en
preparación, fallo/overflow y repetición posterior. No cambiar de dispositivo a
mitad del ensayo: invalidación detiene; volver a lanzar explícitamente.

## Validación disponible y veredicto

Los tests portables compilan y ejecutan DSP/cola propios en Linux: silencio,
fragmentación, cuentas, bit identity a 16 kHz, rechazo de alias de 8.4 y 12 kHz, señal por
canal, orden SPSC concurrente, cola llena y errores de continuidad. Tests Node
inyectados verifican contrato, Stop, timeout, errores, sanitización y replay.
No sustituyen una compilación MSVC, WASAPI real, estabilidad ni precisión acústica.

GO para revisión del código y compilación/aceptación Windows. NO-GO para integrar
Native o aprobar Live hasta completar esa matriz y el replay real. No hay commit,
push, nueva dependencia productiva, descarga ni asset incorporado a Git.
