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
acotada a 2.944.000 muestras / 11.776.000 bytes (184 s) para POSITIVE/SIMILAR
de 180 s. El contrato histórico de 120 s conserva 1.984.000 muestras /
7.936.000 bytes (124 s); no se amplía su límite. SILENCE conserva 60 s y su límite de 1.024.000 muestras / 4.096.000
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
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-calibration-h16-180s'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 180 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
```

El preflight de 180 s no activa micrófono. No usar aquí `--diagnostic-windows`: el
CLI histórico Hito 1.5 continúa fijado a 60 s. La excepción Native de 180 s
requiere el supervisor de calibración y un kind POSITIVE/SIMILAR válido. Revisa el SDK/DLL y fuentes verificadas,
ejecutable, manifiesto/modelos/tokens y configuración. La captura añade
verificación de privacidad del directorio. No ejecutar el EXE directamente:
los flags `--calibration-*` son internos del supervisor con consentimiento.

## Tres tomas, un consentimiento independiente por toma

Mantener micrófono, distancia, entorno y carga. Cada comando pide escribir
`CAPTURAR <KIND> <nonce>` exactamente; el aviso informa la duración (180/60 s).
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
  separar inicios ~7–8 s y completar los veinte pares antes de ~175 s.
  Dejar siempre >1 s de contexto posterior dentro de la captura. Antes de cada pronunciación `b`
  + Enter, esperar `MARKER_ACK ... B ALIGNED`, hablar; después `e` + Enter y
  esperar ACK E. Exactamente veinte pares, nunca ajustar después para lograr hits.
- SILENCE: sesenta segundos sin hablar, sin marcadores y **sin pulsar Enter**.
- SIMILAR: veinte expresiones predefinidas sin «Atlas» (por ejemplo «altas»,
  «alas», «atleta», «atrás»), 180 s, misma cadencia y veinte pares B/E. No guardar las frases en JSON.

Después del ACK 40, **seguir esperando**: no hay cierre anticipado. POSITIVE y
SIMILAR terminan automáticamente a los 180 s; SILENCE a los 60 s. El audio
ambiental sigue almacenándose hasta ese final, aunque ya estén los veinte pares.
En todas: esperar final automático; Enter vacío o Ctrl+C solicita Stop, invalida
la toma como dataset. Cada toma usa proceso/spotter/stream COLD nuevos, .15 como
referencia. No reutilizar capturas independientes como si fueran el mismo PCM.

La duración se fija en consentimiento, manifest y validación del reporte como
`requestedSeconds`. Datasets válidos anteriores de 60 y 120 s siguen legibles;
ausencia del campo significa únicamente contrato anterior de 60 s. SILENCE sólo
admite 60 s. Las nuevas tomas POSITIVE/SIMILAR solicitan 180 s. Se rechazan duraciones
arbitrarias y desacuerdos entre consentimiento/manifest/reporte. El formato F32LE,
los hashes y el algoritmo de asociación no cambian.

Límites por contrato: PCM 64/124/184 s para duraciones 60/120/180 respectivamente;
diagnósticos históricos conservan 1.300 bloques, y únicamente 180 s admite 1.840.
No se amplían 40 ACK, 20 pares B/E, 10.000 Decode, 1.000 hits, 32 timestamps/hit,
los cuatro buffers de audio ni el límite JSON de 4 MiB. Native rechaza 180 s fuera
de calibración con consentimiento o replay específico; el CLI general sólo permite
180 en preflight COLD/.15/--check sin micrófono. Hito 1.5 continúa fijado a 60 s.

El supervisor conserva duración+60 s: 240 s para captura de 180, 180 s para 120,
120 s para SILENCE de 60. Replay contempla las muestras reales hasta 184 s y un
presupuesto máximo de 244 s, sin truncarlas. Completar ventanas no envía Stop:
se conserva la finalización automática y el protocolo de drenaje existente.

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

Con POSITIVE/SIMILAR de 180 s y SILENCE de 60 s, cada matriz tarda aproximadamente
21 minutos de audio más inicialización y cleanup.
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
120/180 s se utiliza el validador de calibración, que reaplica identidad de runtime,
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

La ampliación a 180 s requiere recompilar C++ y generar un lock nuevo mediante
el script, en un directorio de salida nuevo. No editar los hashes manualmente.
Usar los comandos de compilación anteriores y el EXE/lock de esa misma salida. Después,
sólo con consentimiento explícito por toma:

```powershell
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 180 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
node --import tsx experiments/wake-word/calibration-session.ts capture $exe $lock POSITIVE
```

Se mantienen 20 pares B/E y final automático a 180 s sin Enter adicional. Para una
repetición manual, empezar ~2 s después de CAPTURE_STARTED, separar inicios ~7–8 s,
dejar al menos ~2 s entre ACK E y el próximo B y finalizar antes de ~175 s. Son
pautas operativas conservadoras, no READY ni garantía de validez: analizar los
JSON antes de repetir si una captura falla. No modificar marcas ni regenerar
session.json para convertir una sesión rechazada en dataset.


## Límites de JSON, memoria y RSS — ampliación a 180 s

Sólo crecen el buffer privado de retención y la capacidad de registros diagnósticos
para el nuevo contrato; WASAPI, resampler/FIR, cola, pool, Feed, modelo y parámetros
permanecen iguales. No hay telemetría nueva ni READY_FOR_NEXT_WINDOW.

Una cota conservadora de serialización utiliza simultáneamente 1.840 bloques,
10.000 decodificaciones en cada una de las dos listas, 1.000 hits de 32 timestamps,
40 marcadores y ACK, nearZeroPercent del reporte limpio, y 25 caracteres **entre
comillas** para cada float (sobreestima el número sin comillas a precisión 17).
Más 65.536 bytes para cabeceras/campos fijos: **4.000.695 bytes**, frente a
4.194.304 disponibles; margen 193.609 bytes. La regresión comprueba esta cota y
que la cabecera de control cabe en esa reserva. Es cálculo del esquema, no medida
de una captura real. Los límites de lectura/escritura de JSON no se elevan.

El payload de retención es como máximo 11.776.000 bytes; longitud y SHA se verifican
al cargar, en Native antes/después del replay y mediante hash del PCM procesado en
Feed. El padre vuelve a validar el dataset y su identidad después del replay.
Se conservan rechazo de mutación, orden, contabilidad y limpieza por error/Stop.

La reserva privada permanece en memoria hasta destruir Shared; wipe borra las
muestras, pero no garantiza que el allocator devuelva inmediatamente capacidad al
SO. Las lecturas/hash también usan copias finitas: Native puede mantener dos
lecturas de hasta 11.776.000 bytes simultáneamente durante su comprobación final de
replay (23.552.000 bytes de payload). Esto no es el RSS total: se suman runtime,
modelo, contenedores y proceso supervisor. El límite de bloques, Decode/hits y la
reserva inicial mantienen el almacenamiento del harness acotado; no se introduce
crecimiento sin límite ni disco continuo. El consumo real requiere Windows.

Se mantienen las **12 entradas RSS** para no cambiar otro buffer ni el esquema.
El cálculo histórico usa min(11, floor(muestras/160000)): entradas 0–10 corresponden
a rangos previos a 110 s; la última acumula máximos desde 110 s hasta el final,
incluido el margen de muestras. **No son 18 intervalos independientes de 10 s.**
Sigue disponible el pico RSS del proceso informado por Windows. Este perfil grueso
es suficiente como diagnóstico acotado de máximos, pero no permite localizar cuándo
ocurrió un pico después de 110 s ni demuestra ausencia de fugas sostenidas.
Ampliar o versionar esa serie temporal requiere otra aprobación.

Tests en Linux usan exclusivamente metadatos/PCM sintéticos y C++ portátil; no
validan MSVC, WASAPI ni precisión acústica. En Windows comprobar compilación x64,
preflight, consentimiento de 180 s, 40 ACK, fin automático, JSON por debajo de 4 MiB,
cero overflow/pérdidas y cleanup. Un dataset incompleto sigue rechazado aunque
haya hits. Retención siete días y eliminación manual verificada permanecen intactas.
Los datasets antiguos conservan hashes/locks; para ejecutar con su binario original
usar el checkout compatible. No parchear locks para aceptar otro ejecutable.

## Observabilidad de fallos de replay por celda

La segunda matriz comunicada se interrumpió en la quinta celda, SILENCE/.10,
tras validar POSITIVE/.15/.10/.05 y SILENCE/.15, según el prefijo de archivos
conservado en Windows. El error anterior no demuestra la causa Native: el validador
podía convertir FAILED en CAL_REPLAY_CONTRACT_INVALID y no guardaba el reporte
fallido. La instrumentación nueva no puede recuperar retroactivamente ese reporte.
No se ha vuelto a ejecutar esa matriz en cloud ni se ha leído su PCM.

El supervisor ahora comprueba exit code y estado antes de validar los invariantes
de un replay exitoso. FAILED con exit distinto de cero **o con exit 0** sigue
rechazado, conservando el código Native cerrado. El segundo caso registra también
la inconsistencia exit/estado y el rechazo del supervisor. Fallos tempranos sin
cabecera de calibración no se reinterpretan como fallos del contrato exitoso.
JSON inválido, timeout y cierre inesperado siguen rechazados por el mismo runner.
Su observador opcional sólo se ejecuta después de terminar el hijo; no introduce
mensajes, scheduling, backpressure, buffers, cambios de watchdog ni trabajo en audio.

La celda fallida crea exclusivamente `runs/<runId>/<KIND>-<threshold>.failure.json`:
por ejemplo `SILENCE-0.1.failure.json`. No escribe el archivo exitoso de esa celda ni
matrix.json. Se conservan las celdas ya validadas, se detiene la secuencia y no hay
reintentos, saltos ni continuación automática. Archivos creados con wx/0600 bajo
.local, sin sobrescribir. Si falla guardar el diagnóstico, el error de consola
conserva los datos saneados y marca `failureReportSaved:false`; no sustituye la causa
por un mensaje de filesystem. Una escritura interrumpida puede dejar un JSON parcial:
no sobrescribirlo ni interpretarlo como resultado válido.

Contrato diagnóstico schema 1, separado de datasets y resultados exitosos:

- kind, sessionId de 32 hex, threshold y etapa cerrada.
- Exit code, estado conocido, código Native allowlisted y código del supervisor.
  Código desconocido/ausente se representa como null, nunca texto crudo.
- Contadores numéricos seleccionados de captura, muestras/bloques, overflow,
  discontinuidades, errores de secuencia, cola, Decode y hits; longitudes de listas,
  tiempos seleccionados y flags de cleanup.
- Comprobaciones de metadatos y coincidencia de muestras/bloques, hashes y modelo
  como booleanos o null si falta evidencia. No se imprimen los hashes.

No contiene PCM, RMS, espectros, posiciones de hits, timestamps de detecciones,
transcripciones, rutas, nombres/IDs de dispositivos, credenciales, mensajes crudos
ni reporte Native completo. No se conserva una referencia adicional al reporte
bruto en el observador; se toma una proyección numérica acotada. Los tests verifican
que el diagnóstico cabe en 4 KiB y no filtra campos adicionales. Null no demuestra
ausencia de error; un flag de cleanup desconocido no acredita liberación.

Etapas de validación: REPLAY_METADATA, SESSION_LIMITS, REPORT_VALIDATION,
REPLAY_ACCOUNTING, BLOCK_DETAILS, DECODE_DETAILS e HIT_POSITIONS. También se registran
DATASET_LOAD, PREFLIGHT, IDENTITY, NATIVE_EXECUTION/NATIVE_EXIT, DATASET_RECHECK y
ASSOCIATION. La etapa identifica el grupo que falló, no elimina ninguna condición.
Las comprobaciones y la asociación científica anteriores se mantienen intactas.
Los rechazos iniciales de toda la matriz, anteriores al directorio/celdas, conservan
sus códigos existentes y pueden no generar un archivo de fallo por celda.

### Procedimiento Windows para investigar SILENCE/.10

No hay cambios C++: **no hace falta recompilar Native ni editar su lock** para esta
instrumentación. Usar el EXE/lock ya verificados de la ampliación a 180 s. No instalar
SDK/modelos ni borrar el run fallido. Los reportes anteriores conservan su validez
e integridad; el formato de datasets, muestras, hashes y límites no cambia.

Preflight de sólo lectura, sin Native ni acceso al PCM:

```powershell
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 180 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
```

Para obtener evidencia nueva hace falta **una ejecución manual explícita**. Este
comando procesa los PCM autorizados mediante el replay existente; no captura el
micrófono. No ejecutarlo como reintento automático ni reutilizar el UUID anterior:

```powershell
$runDiagnostic = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $runDiagnostic
$matrixExit = $LASTEXITCODE
```

Si falla, leer únicamente sus metadatos saneados:

```powershell
$dir = Join-Path (Get-Location) ".local\wake-word-spike\calibration\runs\$runDiagnostic"
Get-ChildItem -LiteralPath $dir -Filter '*.failure.json' -File | ForEach-Object {
  Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 8
}
```

Interpretación:

- NATIVE_EXIT + AUDIO_OVERFLOW: overflow confirmado por Native; estudiar scheduling
  posteriormente, sin ampliar ni modificar la cola para conseguir un PASS.
- PCM_HASH_MISMATCH/CALIBRATION_PCM_INVALID o flags de hash falsos: investigar
  integridad y fase exacta, sin editar locks, hashes, PCM ni manifests.
- AUDIO_ACCOUNTING_FAILED o diferencias de muestras/bloques: comprobar los contadores
  conservados; no truncar ni completar audio.
- MODEL_LOAD_FAILED/RUNTIME_VERSION_MISMATCH/SDK_HASH_MISMATCH: fallo de inicio o
  procedencia, no una detección acústica negativa.
- Exit 0/COMPLETED con CAL_REPLAY_CONTRACT_INVALID: examinar la etapa y las
  comprobaciones; mantiene el rechazo. NATIVE_LIVE_REPORT_INVALID identifica fallo
  del validador general, también conservado en supervisorCode.
- Sin JSON Native: reportAvailable false y código Native null; no atribuirlo a
  overflow por conjetura. Revisar exit code y código del supervisor.

Si termina correctamente, comparar la primera matriz completa con la nueva mediante
el compare existente. No declarar reproducibilidad con una ejecución o un run parcial:

```powershell
$root = Join-Path (Get-Location) '.local\wake-word-spike\calibration\runs'
node --import tsx experiments/wake-word/calibration-session.ts compare `
  "$root\f706ac8c4ac14e8d9fb1f46a4a990aca\matrix.json" `
  "$root\$runDiagnostic\matrix.json"
```

Dos matrices sólo son consistentes si compare lo confirma sobre los mismos datasets,
modelos y configuración; la instrumentación no constituye aceptación acústica ni GO
productivo. La causa real del fallo original SILENCE/.10 sigue pendiente de evidencia.

## Replay acústico con autorización privada de runtime (experimental)

Esta sección sustituye las instrucciones anteriores de recompilación/replay cuando
se utiliza este checkpoint. No modifica datasets ni resultados históricos.

### Dos modalidades y alcance

- `STRICT_REALTIME` sigue siendo el valor predeterminado. Conserva los deadlines
  absolutos de 100 ms y el push único. Puede recuperar deadlines atrasados en ráfaga;
  un rechazo de la cola sigue siendo `AUDIO_OVERFLOW`. No hay espera de capacidad.
- `ACOUSTIC_BACKPRESSURE` sólo se acepta con `--calibration-replay`. Conserva la
  cadencia nominal inicial y, antes de alimentar cada bloque, espera si los cuatro
  slots están ocupados. La espera usa el evento Stop con intervalos de 5 ms; no
  gira activamente, no bloquea el consumidor ni toca WASAPI. Sólo hay un productor;
  mientras espera, el consumidor únicamente libera slots. Por eso puede comprobar
  capacidad y realizar **un solo push**, sin reservar slots ni reintentar rechazos.
  Si ese push rechaza inesperadamente, se conserva el fallo y no se reintenta.

La fragmentación de 1.600 muestras, cola SPSC, tail sin padding, orden, muestras F32LE,
Feed/decoder, modelos, tokens, thresholds, cooldown y asociación −250/+1000 ms no
cambian. La espera se aplica antes de leer las muestras del siguiente bloque, sin
insertar silencios ni convertir el PCM. Los timestamps de audio siguen expresando
la posición original de las muestras, no el tiempo de pared después de las esperas.
`latencyFromBlockEndMs`/`maxQueueAgeMs` usan el deadline nominal original, **no** un
nuevo timestamp de enqueue ni una latencia acústica medida.

Los reportes de cada celda y matrices nuevos identifican `timingMode`. Native añade
`replayTiming`: waitCount, capacityWaitWallMs, maxCapacityWaitWallMs, totalWallMs y
cancelled. Son tiempos de pared QPC, no CPU. totalWallMs abarca desde el comienzo del
productor hasta el reporte tras los joins/cleanup; processingWallMs sigue midiendo
el trabajo de Feed. Occupancy/overflow y cleanup conservan los campos existentes.
Los fallos también conservan modalidad y métricas numéricas saneadas. Un fallo muy
inicial puede carecer de métricas Native; la modalidad del supervisor sigue registrada.

El timeout del supervisor continúa siendo duración de replay + 60 s, seguido de Stop
cooperativo y, si el hijo no responde en 5 s, terminación de **ese hijo experimental**
con fallo, nunca cleanup acreditado. La espera de capacidad tiene además un deadline
Native finito de duración PCM + 60 s (`CALIBRATION_REPLAY_TIMEOUT`). Cancelación/error
interrumpe el productor; los joins, wipe y contabilidad siguen siendo obligatorios.
No se amplía el watchdog ni se toleran hashes de prefijos como si fueran PCM completo.

**Esta modalidad sólo evalúa acústica offline: nunca acredita rendimiento Live.**
Puede ocultar un déficit temporal del consumidor, deliberadamente separado de su
calidad de reconocimiento. No ofrece garantía de completar ante una pausa arbitraria;
un timeout sigue siendo fallo. No reintenta matrices ni continúa después de una celda
fallida, y conserva resultados anteriores con creación exclusiva.

### Anexo de autorización V1

Cada dataset histórico conserva session.json, consent.json, capture.json, PCM,
anotaciones y SHA originales. No se editan locks ni fechas. El comando manual
`authorize-replay` verifica el dataset completo, preflight del nuevo EXE/SDK/modelos
y exige escribir una frase que incluye dataset, hash del nuevo lock y modalidad.
No ejecuta Native ni abre el micrófono. Sí lee el PCM autorizado localmente para
verificar integridad: no debe ejecutarse en cloud sobre datos privados.

Crea exclusivamente bajo `.local/wake-word-spike/calibration/authorizations/`:
`<dataset>-<replayLockSha256>-<timingMode>.json`, mediante `wx`/0600 y comprobación ACL
Windows del directorio. Nunca sobrescribe una autorización existente. El anexo fija:

- UUID del dataset y digest del manifest original completo.
- SHA de PCM, capture.json y anotaciones.
- Bytes de texto exactos de ambos locks (sólo sus campos cerrados), sus SHA y hash
  del EXE nuevo; procedencia v2.0.0/commit/SDK DLL, identidad de modelos/tokens.
- Configuraciones completas y hashes de keyword de .15/.10/.05, modalidad concreta.
- Consentimiento explícito, creación y expiración **idéntica a la del dataset**.
- integritySha256 del cuerpo. No contiene PCM, contenido acústico ni rutas privadas.

El lock original queda como snapshot de texto verificable contra el hash fijado en
el manifest, sin depender de que su ruta original siga existiendo después de crear
el anexo. El código de reconocimiento (`reference-kws.cc`), transporte/FIR
(`native-live-core.h`) y diagnósticos FN deben conservar los SHA del lock de captura.
Esto autoriza un cambio de runtime para evaluar, **no demuestra equivalencia**.

La salida manual devuelve `authorizationSha256`. Guardarlo como pin de referencia;
la matriz exige explícitamente los tres pins, en orden POSITIVE/SILENCE/SIMILAR.
Antes y después de cada replay se verifican dataset, retención, anexo con su pin,
locks, ejecutable, SDK y modelos. No se acepta un anexo incompleto, alterado, vencido,
con campos adicionales, modo/EXE/dataset/configuración distintos o sin pin. Una
sustitución del archivo con otro self-hash también falla contra el pin suministrado.
El anexo no puede ampliar los siete días; si vencieron los datasets, detenerse y
seguir el procedimiento de eliminación/consentimiento existente, sin editar fechas.

Inmutabilidad operativa: creación exclusiva y comprobación criptográfica con pin
externo. No es almacenamiento WORM ni firma digital; un administrador que pueda
alterar simultáneamente archivos, código y pins está fuera de esta protección.
Conservar los pins en el registro privado de autorización. No publicar anexos,
locks ni hashes de datasets privados en GitHub. La eliminación acústica manual
existente permanece intacta, sin borrado automático; no garantiza borrado físico
seguro en SSD/backups. Los anexos sólo conservan metadatos de auditoría.

`compare` sólo declara consistencia acústica dentro de una modalidad y procedencia
idénticas, con los mismos datasets/PCM, anotaciones y firmas de reconocimiento.
Rechaza modalidades o runtime/autoridad distintos. Un reporte histórico sin modalidad
se interpreta exclusivamente como STRICT_REALTIME, sin inventar métricas. Dos matrices
históricas siguen pudiendo compararse con sus controles originales; una matriz nueva
con procedencia explícita no se declara equivalente automáticamente a una histórica
sin ella. Los archivos históricos nunca se reescriben.

### Windows x64: recompilar y preflight (sin captura)

En Developer PowerShell x64, desde la raíz del repo. Utilizar sólo el SDK ya auditado;
no instalar ni descargar nada. El directorio de salida debe ser nuevo.

```powershell
$sdk = (Resolve-Path '.local\wake-word-spike\native-sdk\v2.0.0-win-x64-shared-MD-Release-no-tts-audit\extracted\sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts').Path
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-calibration-backpressure-v1'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 180 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts status
if ($LASTEXITCODE -ne 0) { throw 'RETENTION_CHECK_FAILED' }
```

### Autorizar cada dataset manualmente

Completar estas variables con IDs y locks originales reales **sin editar archivos**.
Si las capturas comparten lock, las tres variables pueden señalar el mismo archivo.

```powershell
$positive = '<UUID POSITIVE de 32 hex>'
$silence = '<UUID SILENCE de 32 hex>'
$similar = '<UUID SIMILAR de 32 hex>'
$captureLockPositive = '<ruta .local al lock original POSITIVE>'
$captureLockSilence = '<ruta .local al lock original SILENCE>'
$captureLockSimilar = '<ruta .local al lock original SIMILAR>'

node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockPositive $positive ACOUSTIC_BACKPRESSURE
if ($LASTEXITCODE -ne 0) { throw 'AUTH_POSITIVE_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockSilence $silence ACOUSTIC_BACKPRESSURE
if ($LASTEXITCODE -ne 0) { throw 'AUTH_SILENCE_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockSimilar $similar ACOUSTIC_BACKPRESSURE
if ($LASTEXITCODE -ne 0) { throw 'AUTH_SIMILAR_FAILED' }

$authPositive = '<authorizationSha256 devuelto para POSITIVE>'
$authSilence = '<authorizationSha256 devuelto para SILENCE>'
$authSimilar = '<authorizationSha256 devuelto para SIMILAR>'
```

Cada comando exige su frase exacta `AUTORIZAR <dataset> <replayLockSha256> <modo>`.
No automatizar ni redirigir ese consentimiento. Conservar también las salidas manuales
privadamente. El comando falla ante duplicado; no borrar/recrear anexos para conseguir
compatibilidad. Si un anexo existe, usar el pin de su autorización registrada.

### Dos matrices acústicas independientes

Ejecutar cada comando conscientemente; nunca como reintento automático tras fallo.
No hay micrófono. Cada matriz ejecuta nueve procesos secuenciales nuevos, todos
sobre los PCM originales autorizados. Ante error, detenerse y revisar el failure.json;
no ejecutar la siguiente matriz ni comparar resultados parciales.

```powershell
$runAcoustic1 = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $runAcoustic1 --timing-mode ACOUSTIC_BACKPRESSURE --authorizations $authPositive $authSilence $authSimilar
if ($LASTEXITCODE -ne 0) { throw 'ACOUSTIC_MATRIX_1_FAILED' }
```

Sólo después de revisar la primera:

```powershell
$runAcoustic2 = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $runAcoustic2 --timing-mode ACOUSTIC_BACKPRESSURE --authorizations $authPositive $authSilence $authSimilar
if ($LASTEXITCODE -ne 0) { throw 'ACOUSTIC_MATRIX_2_FAILED' }
$root = Join-Path (Get-Location) '.local\wake-word-spike\calibration\runs'
node --import tsx experiments/wake-word/calibration-session.ts compare "$root\$runAcoustic1\matrix.json" "$root\$runAcoustic2\matrix.json"
if ($LASTEXITCODE -ne 0) { throw 'ACOUSTIC_REPRODUCIBILITY_FAILED' }
```

Examinar los nueve reportes y sus métricas de espera/cola/cleanup. Exigir SHA original
= SHA en Feed, muestras/bloques exactos, mismas posiciones/hits y asociación válida,
0 overflow, cleanup completo y compare satisfactorio. No exigir un número artificial
de detecciones ni ajustar parámetros para forzar coincidencias. Ninguna prueba
sintética sustituye estos resultados Windows sobre los PCM autorizados.

### Evaluación temporal independiente

Autorizar **otros anexos**, específicos de STRICT_REALTIME, para los mismos tres
UUID/locks y EXE nuevo:

```powershell
node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockPositive $positive STRICT_REALTIME
if ($LASTEXITCODE -ne 0) { throw 'STRICT_AUTH_POSITIVE_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockSilence $silence STRICT_REALTIME
if ($LASTEXITCODE -ne 0) { throw 'STRICT_AUTH_SILENCE_FAILED' }
node --import tsx experiments/wake-word/calibration-session.ts authorize-replay $exe $lock $captureLockSimilar $similar STRICT_REALTIME
if ($LASTEXITCODE -ne 0) { throw 'STRICT_AUTH_SIMILAR_FAILED' }
$strictPositive = '<pin STRICT POSITIVE>'
$strictSilence = '<pin STRICT SILENCE>'
$strictSimilar = '<pin STRICT SIMILAR>'
$runStrict = [guid]::NewGuid().ToString('N')
node --import tsx experiments/wake-word/calibration-session.ts matrix $exe $lock $positive $silence $similar $runStrict --timing-mode STRICT_REALTIME --authorizations $strictPositive $strictSilence $strictSimilar
if ($LASTEXITCODE -ne 0) { throw 'STRICT_TIMING_FAILED_REVIEW_DIAGNOSTICS' }
```

STRICT conserva overflow como fallo y cero esperas de capacidad. Si se necesita
comparar repetibilidad temporal, realizar otra matriz STRICT manual con UUID nuevo
y los mismos pins, y comparar únicamente esas dos matrices. No comparar STRICT y
ACOUSTIC como equivalentes. Incluso un STRICT PASS sólo es una prueba del replay
pautado: no valida captura WASAPI Live ni sustituye su aceptación independiente.
El CLI histórico de seis argumentos sigue siendo STRICT y sólo omite anexo cuando
su lock coincide exactamente con el del dataset; no admite automáticamente un EXE
nuevo. El replay WAV histórico .25 queda intacto.

Estado: implementado y verificable con pruebas sintéticas en Linux. Compilación MSVC,
aceptación de DLL/EXE nuevo y dos matrices Windows consistentes pendientes. GO sólo
para evaluación experimental; NO-GO para integración productiva.
