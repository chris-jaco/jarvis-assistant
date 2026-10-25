# Hito 1.5 — diagnóstico Native de omisiones

Experimental, pendiente de compilación y aceptación en Windows. No integra
Native Live con Atlas. No cambia reconocimiento, WASAPI, FIR, canal 0, modelo,
tokens, transporte ni cola. No descarga assets ni guarda audio.

## Preparación y dos pruebas Windows x64

Usar Developer PowerShell x64, MSVC y el SDK auditado ya disponibles. Desde la
raíz del repositorio, con modelos/manifiesto locales existentes. La salida de
compilación debe ser una carpeta **nueva**; los locks anteriores no acreditan
las nuevas fuentes. No editar locks ni reutilizar ejecutables antiguos.

```powershell
$sdk = (Resolve-Path '.local\wake-word-spike\native-sdk\v2.0.0-win-x64-shared-MD-Release-no-tts-audit\extracted\sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts').Path
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-fn-h15'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 --threshold 0.15 --diagnostic-windows --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }

# A: 20 pronunciaciones habituales. No iniciar B hasta finalizar y liberar A.
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 --threshold 0.15 --diagnostic-windows --detail | Set-Content -Encoding utf8 "$out\session-A.json"
if ($LASTEXITCODE -ne 0) { throw 'SESSION_A_INCOMPLETE' }

# B: 20 pronunciaciones con articulación clara, sin exagerarla.
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 --threshold 0.15 --diagnostic-windows --detail | Set-Content -Encoding utf8 "$out\session-B.json"
if ($LASTEXITCODE -ne 0) { throw 'SESSION_B_INCOMPLETE' }

node --import tsx experiments/wake-word/native-fn.ts analyze "$out\session-A.json" | Set-Content -Encoding utf8 "$out\analysis-A.json"
if ($LASTEXITCODE -ne 0) { throw 'ANALYSIS_A_FAILED' }
node --import tsx experiments/wake-word/native-fn.ts analyze "$out\session-B.json" | Set-Content -Encoding utf8 "$out\analysis-B.json"
if ($LASTEXITCODE -ne 0) { throw 'ANALYSIS_B_FAILED' }
node --import tsx experiments/wake-word/native-fn.ts compare "$out\analysis-A.json" "$out\analysis-B.json" | Set-Content -Encoding utf8 "$out\comparison.json"
if ($LASTEXITCODE -ne 0) { throw 'COMPARISON_FAILED' }
```

No automatizar capturas en cloud. Usar el mismo micrófono, formato, distancia,
entorno y carga en ambas pruebas. Cada comando inicia un proceso y motor nuevos:
COLD, threshold .15, score 1, maxActivePaths 4, cooldown 1000 ms.

### Anotación en el mismo terminal que ejecuta Native Live

La salida JSON va al archivo; los estados y ACK aparecen en stderr. **Este modo
reemplaza el anotador independiente de Hito 1.4**: no usar `start`, `confirm` ni
timestamps de otro terminal.

1. Esperar `CAPTURE_STARTED`. Empezar a los ~2 s y separar inicios ~2.5 s.
2. Para cada intento escribir `b` y Enter. Esperar `MARKER_ACK <id> B ALIGNED`.
3. Decir «Atlas», después escribir `e` y Enter. Esperar su ACK `E ALIGNED`.
4. Repetir exactamente veinte pares. Dejar contexto posterior al último intento;
   esperar finalización automática a los 60 s. Enter vacío o Ctrl+C solicita Stop.

`MARKER_NOT_READY` significa que no se envió otro marcador; no hablar hasta
tener ACK de inicio. Un ACK `AMBIGUOUS`, ausente o fuera de orden no se corrige
manualmente ni mediante reintentos automáticos. No interpretar sensibilidad si
faltan ventanas fiables. No contar una captura cancelada como ensayo completo.

## Sincronización e incertidumbre

El supervisor crea un trialId aleatorio de 128 bits. Protocolo cerrado:
`M <trialId> <id> B/E` y `ACK <trialId> <id> B/E <qpcMs>`; IDs 1–40 únicos,
alternados, máximo un ACK pendiente. El control Native fecha la recepción con
QPC relativo a un origen de ese proceso. Las posiciones de audio existentes
proceden del timestamp QPC de WASAPI, corregido por el retardo FIR. Las métricas
usan esos mismos bloques, sin alterar captura ni conversión.

No se restan relojes de Node y Native. Node mide únicamente la ida y vuelta
local con su propio reloj monotónico. La acción de envío queda acotada
conservadoramente por `[qpcMs − RTT, qpcMs]`; el RTT incluye scheduling y entrega
del ACK. RTT >50 ms, ACK perdido, canal fallido, ventanas solapadas o hit sobre
un límite incierto producen AMBIGUOUS. No es una medición de CPU.

Se conserva −250/+1000 ms. La asociación debe ser válida para todo el intervalo
de incertidumbre; las ventanas posibles se usan para detectar ambigüedades,
no para ampliar silenciosamente el margen aceptado. Hay una tolerancia numérica
explícita de 2 ms entre timestamps de bloques; saltos o solapamientos mayores
impiden una asociación fiable. **No es una certificación de precisión del hardware
de 2 ms**: debe comprobarse en Windows. La exactitud del reloj de dispositivo y
la reacción manual no se deducen del RTT. Los marcadores delimitan la acción del
operador, no el inicio/fin fonético exacto de la palabra. Si se observa una duda
de alineación externa a estas comprobaciones, no interpretar el resultado.

La posición del hit es el final QPC del bloque que produjo el resultado, no un
onset acústico. La latencia informada respecto al fin anotado incluye los límites
de la anotación y la segmentación; `acousticLatencyMs` permanece null.

## Métricas, cobertura y categorías

`fnDiagnostics` es un campo opcional aditivo del reporte schema 1, con versión
propia 1. El validador comprueba límites, tipos, finitud, secuencias, muestras,
sumSquares/RMS/peak, conteos, pares de marcadores, ACK y relaciones con Decode y
posiciones. Sólo conserva campos allowlisted. Los reportes antiguos siguen
legibles; sin este contrato el análisis Hito 1.5 devuelve NOT_EVALUABLE.

Por bloque posterior al FIR: muestras e índices de inicio/fin, suma de cuadrados,
RMS, peak absoluto, nearZero (y porcentaje derivado), clipping, inválidas, QPC,
tiempo de cálculo de métricas, finalización, llamadas a Decode y rawHits. Las
llamadas Decode tienen inicio/fin QPC relacionados con el bloque. No se conservan
PCM, fases, espectros, transcripciones, embeddings ni nombres/IDs de dispositivo.
Estas estadísticas no permiten reconstruir las muestras originales.

NearZero usa |x| <1e-5; clipping usa |x| >=.999 como indicador numérico, no prueba
de saturación física. Baja señal requiere conjuntamente RMS <.003 (~−50.5 dBFS)
y peak <.02 (~−34 dBFS). Son umbrales diagnósticos conservadores de señal próxima
a silencio, **no** detección de voz, inteligibilidad ni causalidad acústica.

Una ventana que corta un bloque de 100 ms no permite recuperar su energía exacta.
El análisis conserva dos agregados: bloques interiores completos y bloques
exteriores solapados. No divide sumSquares proporcionalmente ni reconstruye
muestras. Si ambos agregados discrepan respecto a baja señal, o no hay bloque
interior, la ventana es AMBIGUOUS. Clipping en una omisión también es ambiguo.

Reglas, en orden:

| Categoría | Regla |
|---|---|
| AMBIGUOUS | Alineación/ACK incierto, ventanas compartidas, salto temporal, hit sobre límites inciertos o energía no atribuible a la ventana |
| MISSED_CAPTURE_ISSUE | Sin hit aceptado y cobertura incompleta, bloque no terminado o muestras inválidas en ventana/margen |
| MATCHED | Al menos un hit aceptado asociado inequívocamente a esa ventana, con cobertura verificable; adicionales son duplicados |
| MISSED_LOW_SIGNAL | Sin hit aceptado, cobertura válida y ambos agregados bajo los dos umbrales |
| MISSED_WITH_VALID_AUDIO | Sin hit aceptado, cobertura válida y ambos agregados fuera de baja señal; causa del reconocimiento desconocida |

RawHits, aceptados y suprimidos se separan aplicando el cooldown existente al
reloj de muestras. Un rawHit suprimido no se convierte en acierto. Hits aceptados
fuera de todas las ventanas fiables se cuentan como falsos positivos. Faltando
alineación no se informa ese conteo como definitivo. Sensibilidad sólo se calcula
con captura COMPLETED y veinte intentos evaluables; se conservan los veinte
resultados y el denominador. La comparación A/B requiere identidad de modelo,
configuración y formato efectivos; diferencias son correlaciones, no causas.

## No bloqueo, fallos y validación

El control recibe marcadores; inferencia calcula métricas. Captura no espera
ACK, no adquiere locks nuevos y no realiza I/O de diagnósticos. En este modo
sus mensajes numéricos/de estado van a 64 slots de metadatos con productores
atómicos sin spin, espera ni asignación. Un escritor dedicado hace el I/O; no
hay cola adicional de audio. Exceder capacidad o fallar el escritor detiene el
ensayo explícitamente. El resto del transporte permanece intacto.

El cierre del escritor se solicita **después** de unir los hilos de audio y
liberar el micrófono; hay cancelación de I/O y watchdog del supervisor. No se
garantiza recuperación cooperativa de una DLL o pipe colgado: el supervisor
puede terminar exclusivamente su hijo experimental y nunca acreditar cleanup
normal en ese caso. No termina Atlas ni otros procesos.

Las métricas agregan coste del observador, registrado por bloque; no prueban que
la instrumentación carezca de efecto sobre scheduling. Tests deterministas y
C++ portátil prueban protocolos, cola diagnóstica, cálculos, ambigüedades,
cancelación, errores y compatibilidad; no prueban reconocimiento real ni WASAPI.

GO sólo para las dos pruebas manuales tras compilar y verificar locks en Windows.
NO-GO para declarar sensibilidad acústica validada, integrar en Atlas o cambiar
modelo/parámetros/transporte a partir de estas pruebas sintéticas.
