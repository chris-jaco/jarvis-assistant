# Hito 1.6 — calibración Native local y reproducible

Implementación experimental; **compilación MSVC, ACL/WASAPI y aceptación acústica
Windows pendientes**. No integra Native en Atlas ni modifica sus dependencias.
No se capturó audio real en cloud. La aprobación de implementación no sustituye
el consentimiento interactivo antes de **cada** toma.

## Contratos y auditoría

El replay histórico continúa intacto: WAV PCM16 mono/16 kHz, 330.411 muestras,
threshold .25, SHA F32LE
`ddd500ae3b79de9fa1f9af82c04142dfd1b06dd2fca5237008f0cd3af3b5138b`,
tres hits (27/46/91), 64 Decode y comparación WASM original. Sus pins no se
retiran. `--replay --threshold 0.15` sigue rechazado.

El contrato nuevo `ATLAS_CALIBRATION_F32LE_V1` usa **PCM crudo F32LE mono/16 kHz**,
no WAV ni PCM16. Es la copia exacta de los float32 post-FIR que llegan a Feed.
No permite importar/converter WAV arbitrarios ni reutilizar el antiguo WAV como
si fuese una toma nueva. El almacenamiento no contiene cabecera, nombres de
micrófono ni identificadores del dispositivo. Su longitud es `4 × muestras`.

No cambian WASAPI, FIR, canal 0, transporte, colas/pool ni Feed/decodificador.
El tap vive en inferencia, antes de Feed, y conserva bits (incluido −0) en memoria
acotada a 1.984.000 muestras / 7.936.000 bytes (124 s) para POSITIVE/SIMILAR
de 120 s. SILENCE conserva 60 s y su límite de 1.024.000 muestras / 4.096.000
bytes (64 s). Los cuatro segundos de capacidad adicional son margen finito de
contabilidad, no padding ni tiempo extra de micrófono. Sólo en tomas COLD/.15. La copia no espera al disco ni asigna memoria por bloque;
la reserva ocurre antes de iniciar los hilos. Es coste adicional del observador.
Si falta espacio o se pierde orden, falla explícitamente. Una toma incompleta,
fallida o cancelada no se acepta; su memoria se limpia.

La escritura exclusiva ocurre **después de unir los hilos y liberar micrófono y
motor**, con `CREATE_NEW`, flush y hash de comprobación. No hay escritor ni cola
adicional de audio en captura. No se sobrescriben archivos. Si falla el disco o
se cancela durante persistencia puede quedar un archivo parcial: se conserva
para eliminación manual, nunca se acepta como dataset. No hay borrado silencioso.

Spotter y keyword usan el mismo threshold. Cambian juntos únicamente .15/.10/.05;
`Math.fround` comprueba el valor efectivo global. La keyword sigue `▁a t la s`,
score 1, beam 4, cooldown 1000 ms, featureDim 80, trailingBlanks 1, CPU y un hilo.
Su hash cambia por threshold; pesos/tokens/SDK permanecen idénticos. Se verifican
los locks previos más SHA del nuevo header Native; recompilar, no editar locks.

A1/A2 no se recibieron como reportes originales identificados en este checkpoint.
Los conteos comunicados no demuestran sensibilidad. `native-calibration.ts audit`
conserva la auditoría por hash de esos JSON: distingue rawHits, aceptados y
ventanas asociadas, devuelve NOT_EVALUABLE para evidencia antigua insuficiente y
nunca considera dos capturas Live prueba de igualdad de PCM. `design` describe
la matriz nueva sin ejecutar motores ni consentir capturas.

## Privacidad, almacenamiento y retención

Todo se guarda en `.local/wake-word-spike/calibration/captures/<nonce>/`, ignorado
por Git. Antes de capturar se exige una frase exacta con kind y nonce nuevos en
TTY. Redirigir una respuesta o omitirla no otorga consentimiento. No hay captura
programada/automática, red, OpenAI ni envío externo desde estas herramientas.

Un chequeo PowerShell **sólo de lectura** exige directorio propiedad del usuario
actual, sin grants de lectura/escritura de datos a terceros fuera de usuario,
SYSTEM y administradores locales. Si no puede verificarlo, aborta antes del
micrófono (`CAL_PRIVATE_DIRECTORY_UNVERIFIED`). No modifica ACL ni eleva permisos.
Native exige un volumen local fijo (rechaza UNC/unidades de red),
links/junctions/reparse paths y sobrescrituras. Revisar el directorio
manualmente si falla el chequeo; no deshabilitarlo para continuar.

Usar un repositorio fuera de OneDrive/Dropbox u otras sincronizaciones/backups,
o excluir expresamente ese directorio antes de consentir. `.gitignore` no
impide que otro software copie archivos. Administradores/SYSTEM y compromiso
del equipo permanecen fuera de la garantía de privacidad del harness.

`consent.json` fija creación y vencimiento **UTC a siete días exactos**, antes de
lanzar Native, incluso si luego falla. Nunca se renueva por lectura/replay.
`status` advierte sobre PCM vencido o metadatos inválidos. Nuevas capturas se
bloquean con esos pendientes; un replay vencido se rechaza. No hay servicio de
fondo: sin ejecutar comandos no puede emitirse una alarma. El cumplimiento del
límite exige que el propietario elimine manualmente antes del vencimiento.

`capture.json` contiene sólo diagnóstico numérico e identidad/hash del PCM,
`session.json` vincula modelo, lock, reporte, ventanas y hashes. Cancelaciones
con reporte conservan `incomplete-capture.json`; errores conservan `failure.json`
sin mensajes privados. Ausencia de `session.json` significa toma no aceptada.
No hay PCM en stdout/stderr, JSON, transcripciones, espectros ni embeddings.

## Compilar y preflight — Windows x64

Developer PowerShell x64; SDK oficial auditado y dependencias ya existentes.
La carpeta de salida debe ser **nueva**. No descargar SDK/modelos ni instalar nada.

```powershell
$sdk = (Resolve-Path '.local\wake-word-spike\native-sdk\v2.0.0-win-x64-shared-MD-Release-no-tts-audit\extracted\sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts').Path
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-calibration-h16-120s'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 120 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
```

El preflight de 120 s no activa micrófono. No usar aquí `--diagnostic-windows`: el
CLI histórico Hito 1.5 continúa fijado a 60 s. La excepción Native de 120 s
requiere el supervisor de calibración y un kind POSITIVE/SIMILAR válido. Revisa el SDK/DLL y fuentes verificadas,
ejecutable, manifiesto/modelos/tokens y configuración. La captura añade
verificación de privacidad del directorio. No ejecutar el EXE directamente:
los flags `--calibration-*` son internos del supervisor con consentimiento.

## Tres tomas, un consentimiento independiente por toma

Mantener micrófono, distancia, entorno y carga. Cada comando pide escribir
`CAPTURAR <KIND> <nonce>` exactamente; el aviso informa la duración (120/60 s).
Sólo después puede iniciar el micrófono.
Asegurarse de no grabar a otras personas sin consentimiento.

```powershell
node --import tsx experiments/wake-word/calibration-session.ts capture $exe $lock POSITIVE
# Copiar sessionId del JSON exitoso a $positive. No copiar un ID fallido.
$positive = 'REEMPLAZAR_POR_32_HEX'

node --import tsx experiments/wake-word/calibration-session.ts capture $exe $lock SILENCE
$silence = 'REEMPLAZAR_POR_32_HEX'

node --import tsx experiments/wake-word/calibration-session.ts capture $exe $lock SIMILAR
$similar = 'REEMPLAZAR_POR_32_HEX'
```

- POSITIVE: veinte «Atlas» naturales; empezar ~2 s después de CAPTURE_STARTED,
  separar inicios ~4–5 s y completar los veinte pares antes de ~115 s.
  Dejar siempre >1 s de contexto posterior dentro de la captura. Antes de cada pronunciación `b`
  + Enter, esperar `MARKER_ACK ... B ALIGNED`, hablar; después `e` + Enter y
  esperar ACK E. Exactamente veinte pares, nunca ajustar después para lograr hits.
- SILENCE: sesenta segundos sin hablar, sin marcadores y **sin pulsar Enter**.
- SIMILAR: veinte expresiones predefinidas sin «Atlas» (por ejemplo «altas»,
  «alas», «atleta», «atrás»), 120 s, misma cadencia y veinte pares B/E. No guardar las frases en JSON.

Después del ACK 40, **seguir esperando**: no hay cierre anticipado. POSITIVE y
SIMILAR terminan automáticamente a los 120 s; SILENCE a los 60 s. El audio
ambiental sigue almacenándose hasta ese final, aunque ya estén los veinte pares.
En todas: esperar final automático; Enter vacío o Ctrl+C solicita Stop, invalida
la toma como dataset. Cada toma usa proceso/spotter/stream COLD nuevos, .15 como
referencia. No reutilizar capturas independientes como si fueran el mismo PCM.

La duración se fija en consentimiento, manifest y validación del reporte como
`requestedSeconds`. Datasets válidos anteriores de 60 s siguen legibles; ausencia
del campo significa únicamente contrato anterior de 60 s. SILENCE de 120 s,
duraciones arbitrarias y desacuerdos entre consentimiento/manifest/reporte se
rechazan. Las nuevas tomas POSITIVE/SIMILAR siempre solicitan 120 s, no 60.

Auditoría de límites: Native general ya admitía 120 s; no cambia Capture/WASAPI.
El límite diagnóstico existente de 1.300 bloques cubre hasta 124 s; no se amplía.
Tampoco cambia el límite de 40 ACK, ni los 20 pares B/E, ni 10.000 Decode, ni los
4 buffers de audio. El supervisor conserva la fórmula duración+60 s: timeout
180 s para capturas de 120, 120 s para SILENCE de 60. En replay se contempla
además el número real de muestras (máximo 184 s de presupuesto), sin truncarlas.
Completar ventanas no envía Stop: cambiarlo confundiría cancelación con éxito y
requeriría un protocolo nuevo de drenaje. Se conserva la finalización automática.

## Nueve evaluaciones y repetición de consistencia

Se usan los mismos tres archivos capturados una sola vez; **matrix no abre el
micrófono**. Ejecuta nueve procesos secuenciales nuevos: POSITIVE/SILENCE/SIMILAR
× .15/.10/.05. Verifica hashes antes/después y en la frontera real de Feed,
número/orden de muestras y bloques, modelo/tokens/runtime, configuración y lock.
No hay padding, normalización, cuantización, nuevo FIR ni InputFinished.

```powershell
$run1 = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $run1
if ($LASTEXITCODE -ne 0) { throw 'MATRIX_1_FAILED' }

# Segunda ejecución explícita, para reproducibilidad; no es un reintento automático.
$run2 = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $run2
if ($LASTEXITCODE -ne 0) { throw 'MATRIX_2_FAILED' }
$root = Join-Path (Get-Location) '.local\wake-word-spike\calibration'
node --import tsx experiments/wake-word/calibration-session.ts compare "$root\runs\$run1\matrix.json" "$root\runs\$run2\matrix.json"
if ($LASTEXITCODE -ne 0) { throw 'RESULTS_INCONSISTENT' }
```

Con POSITIVE/SIMILAR de 120 s y SILENCE de 60 s, cada matriz tarda aproximadamente
15 minutos de audio más inicialización y cleanup.
La segunda matriz son otras nueve ejecuciones de los mismos datasets, sin nuevas
capturas. Nunca comparar una matriz consigo misma como prueba de independencia.
Resultados bajo `runs/<runId>/`: nueve JSON y matrix.json con .15 como referencia,
deltas, muestras/hashes, hits, posiciones, suprimidos, duplicados, omisiones y FP.
Una discrepancia o ambigüedad detiene la matriz; resultados parciales no son éxito.
No sobrescribir, reparar ni relajar pins para conseguir equivalencia.

## Sincronización y asociación

B/E y bloques utilizan QPC relativo del mismo proceso. Node sólo mide RTT,
no resta su reloj a QPC. Cada marcador se conserva junto a su RTT y se convierte
mediante bloques vecinos a un intervalo de muestras: QPC entre `marca−RTT−2 ms`
y `marca+2 ms`, con redondeo conservador floor/ceil. Se registran límites,
incertidumbre en muestras y rango de desfase QPC−reloj de muestras. No se cambia
el timestamp ni se fija artificialmente el origen en CAPTURE_STARTED.

Se rechazan ACK ausentes/tardíos (>50 ms), orden incorrecto, huecos/saltos >2 ms,
ventanas solapadas, falta de cobertura y begin/end que no se pueden separar.
El margen continúa −250/+1000 ms (4000/16000 muestras). Un hit debe quedar dentro
para **todo** el intervalo incierto y pertenecer a una sola ventana; de lo
contrario falla como ambiguo. El hash de ventanas queda fijado al terminar la toma,
antes del barrido, y vuelve a derivarse del reporte original al abrir el dataset.

El analizador histórico Hito 1.5 conserva su contrato de 60 s. Para datasets de
120 s se utiliza el validador de calibración, que reaplica identidad de runtime,
modelos, keyword, diagnóstico QPC y contabilidad con la duración declarada.

El punto del hit es el final del bloque que produjo el resultado (granularidad
hasta 100 ms), no onset acústico. Los límites manuales y 2 ms de tolerancia no
certifican precisión de hardware ni ground truth fonético. La latencia se muestra
como intervalo respecto al fin anotado, separada del tiempo de entrega del bloque;
acousticLatencyMs permanece null. Nunca se atribuye un acierto por rawHits solos.

El cooldown sigue exactamente block*100 ms y 1000 ms. En POSITIVE una ventana
con hit aceptado es un acierto; adicionales son duplicados, ausencias son omisiones,
y aceptados fuera son FP. Se informan también todos los rawHits y supresiones.
En SILENCE/SIMILAR todos los hits son controles negativos, nunca aciertos. FP/h
incluye duración y conteos; no extrapolar un minuto de silencio a ocho horas.

## Eliminación manual verificable

Ejecutar status al empezar y al terminar, y eliminar **antes** de siete días:

```powershell
node --import tsx experiments/wake-word/calibration-session.ts status
node --import tsx experiments/wake-word/calibration-session.ts delete $positive
# Escribir BORRAR <sessionId> exactamente cuando lo solicite.
node --import tsx experiments/wake-word/calibration-session.ts delete $silence
node --import tsx experiments/wake-word/calibration-session.ts delete $similar
node --import tsx experiments/wake-word/calibration-session.ts status
```

`ACOUSTIC_ABSENT` se emite sólo después de comprobar ausencia del archivo. El
borrado sólo afecta a capture.f32le de ese ID con consentimiento registrado;
no sigue links ni borra recursivamente. Se conservan metadatos y reportes numéricos.
También permite limpiar PCM parcial de una toma fallida con consent.json.
Si los metadatos están dañados, el comando falla: revisar/eliminar manualmente
el archivo preciso en Explorer y verificar su ausencia. No usar un borrado genérico.

La eliminación lógica **no garantiza borrado físico seguro en SSD, backups o
sincronizaciones**, ni borra copias externas. Revisarlas según la política local.
No se programa ni se efectúa borrado silencioso al vencer.

## Aceptación y límites

Integridad: nueve celdas completas, mismas muestras/hash y modelo por dataset,
parámetros idénticos salvo threshold, cero pérdidas/saltos/overflow, cleanup
verificado, veinte ventanas positivas/control fiables y ninguna en silencio.
Entre repeticiones del mismo threshold exigir igualdad de hits/posiciones,
asociaciones y secuencia de llamadas Decode. Entre thresholds pueden diferir
hits y cantidad de Decode. No confundir pared con CPU; tiempos pueden variar.

Objetivo experimental: >=90 % de veinte positivos asociados, sin duplicados
aceptados ni rawHits en controles. Evaluar FP y omisiones antes de elegir umbral;
.15 es referencia, no ganador automático. Tests sintéticos y dos matrices no
certifican precisión general, ocho horas sin FP ni estabilidad Live prolongada.

En Linux se verifican cálculos/contratos, consentimiento, integridad, retención,
borrado, links, reproducibilidad y tap C++ portátil, sin audio real ni SDK ejecutado.
El chequeo ACL PowerShell y toda la rama WASAPI/MSVC requieren Windows. Cuelgues
de DLL o disco dependen del watchdog existente, que sólo termina el hijo propio;
no se acredita cleanup normal si no pudo verificarse. Riesgos residuales:
observador, scheduling, anotación humana, control del reloj/retención manual,
acceso administrativo y software externo de copia. Hashes locales no son firmas
contra edición deliberada del propietario.

GO sólo para aceptación experimental Windows con consentimiento por toma.
**NO-GO para integración productiva o declarar precisión acústica validada.**

## Diagnóstico de alineación por ventana (sin leer PCM)

`ALIGNED` en un ACK sólo verifica identidad/orden del marcador y RTT <=50 ms.
No certifica cobertura del marcador, contexto o separación de ventanas ampliadas.
El código global continúa `CAL_ALIGNMENT_AMBIGUOUS`; se añaden `diagnostics` al
error de consola y a nuevos `failure.json`. Los archivos existentes no se editan.
El validador conserva comparaciones, floor/ceil, umbrales y márgenes anteriores.
Recoge todas las causas independientes evaluables, sin inventar una conversión
para un marcador sin cobertura. Un fallo de mapeo puede impedir evaluar causas
posteriores; ausencia de esas causas no demuestra que estén descartadas.

| Motivo | Condición conservada |
| --- | --- |
| `PRE_CONTEXT_MISSING` | begin.lower <4000 muestras |
| `POST_CONTEXT_MISSING` | end.upper +16000 > muestras procesadas |
| `QPC_DISCONTINUITY` | hueco o solapamiento absoluto entre bloques >2 ms |
| `MARKER_OUTSIDE_COVERAGE` | intervalo QPC completo del marcador sin cobertura |
| `MARKER_UNCERTAINTY_OVERLAP` | begin.upper >= end.lower |
| `EXPANDED_WINDOWS_OVERLAP` | begin.lower −4000 <= end.upper anterior +16000 |
| `INSUFFICIENT_EVIDENCE` | ACK ausente/RTT >50 ms, pares incompletos, bloque inválido o evidencia insuficiente |

Cuando son calculables se incluyen ventana/marcador/bloque, QPC, separación
observada, mínimo requerido, déficit en ms y tolerancia máxima. Un límite estricto
entre índices enteros necesita al menos una muestra (0,0625 ms): igualdad sigue
rechazada. `deficitMs` es distancia al límite permitido, no una corrección aplicada.
Un salto QPC incluye signo en observedSeparationMs, valor absoluto para el déficit.
Los QPC son relativos al proceso Native; no se restan a performance.now de Node.

Auditar la sesión existente, sin compilar ni ejecutar Native:

```powershell
node --import tsx experiments/wake-word/calibration-session.ts audit a9e12de19a0ef49b0dbc17cfca3dd8f8 POSITIVE
```

Lee sólo los nombres fijos capture.json y, si existe, failure.json bajo la carpeta
local de esa sesión. No lee capture.f32le, no escribe reportes ni modifica los
originales, no abre el micrófono ni inicia inferencia. Devuelve affectedWindows
sin contar un rawHit como acierto. Exit 2 si ALIGNMENT_REJECTED/NOT_EVALUABLE;
exit 0 sólo significa ALIGNMENT_VALID para estas comprobaciones, nunca aceptación
del dataset, integridad del PCM ni autorización de mantenimiento/producción.
Los reportes antiguos suficientes mantienen el mismo resultado; sin evidencia
QPC suficiente se rechazan o declaran NOT_EVALUABLE. Los textos crudos y campos
ajenos de failure.json no se imprimen. La sesión Windows no está disponible en
cloud: no se confirma solapamiento ni otro motivo hasta ejecutar esta auditoría.

### Límite de asistencia temporal y decisión pendiente

No se implementa `READY_FOR_NEXT_WINDOW`: con el protocolo actual, el supervisor
sólo recibe QPC en los ACK B/E, y los bloques QPC/muestras al terminar. Esperar
1250 ms (o más) en Node no demuestra separación en el reloj de muestras. Incluso
QPC de dos marcadores suficientemente separados puede cruzar una discontinuidad
QPC/muestras. La ausencia de errores WASAPI no demuestra esa condición adicional.
No se añade un temporizador que emita READY ni se cambia el envío de B/E.

Para una asistencia verificable se propone aprobar por separado telemetría Native
acotada, no bloqueante, de avance y cobertura QPC/muestras; evaluar un margen
operativo explícito adicional (por ejemplo 100 ms), nunca ampliar −250/+1000 ms.
Debe definirse el alcance de READY: separación respecto a cobertura observada y
comprobación del siguiente B, no promesa sobre fallos futuros. Hasta aprobar ese
contrato de observación/sincronización, la asistencia queda NO-GO. El diagnóstico
final seguirá siendo obligatorio y ningún aviso podrá convertir un rechazo en PASS.

No hay cambios C++ en este checkpoint: no hace falta recompilar el EXE auditado.
Si se requiere una compilación nueva, usar los comandos anteriores con un directorio
nuevo, por ejemplo `.local\wake-word-spike\native-calibration-window-audit`.
Ejecutar el preflight de 120 s con el EXE y lock de esa misma salida. Después,
sólo con consentimiento explícito por toma:

```powershell
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 120 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
node --import tsx experiments/wake-word/calibration-session.ts capture $exe $lock POSITIVE
```

Se mantienen 20 pares B/E y final automático a 120 s sin Enter adicional. Para una
repetición manual, empezar ~2 s después de CAPTURE_STARTED, separar inicios ~4–5 s,
dejar al menos ~2 s entre ACK E y el próximo B y finalizar antes de ~115 s. Son
pautas operativas conservadoras, no READY ni garantía de validez: analizar los
JSON antes de repetir si una captura falla. No modificar marcas ni regenerar
session.json para convertir una sesión rechazada en dataset.
