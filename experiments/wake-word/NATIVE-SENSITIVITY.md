# Hito 1.4 — sensibilidad Native Live (preparado, pendiente de Windows)

Para el diagnóstico de omisiones con marcadores Native + ACK y métricas por
bloque usar [Hito 1.5](NATIVE-FALSE-NEGATIVES.md). El anotador independiente de
este documento no aporta por sí mismo alineación suficiente para Hito 1.5.

Sólo harness experimental. El propietario comunicó Native Warm 14 detecciones,
Cold 12 detecciones sobre 20 intentos, cero overruns y RTF ~.089/.088 en 60 s.
Son conteos provisionales; sin ventanas temporales no prueban sensibilidad.
No se repitieron esos ensayos en cloud ni se aprueba integración en Atlas.

## Configuración e integridad

`native-live.ts` y el ejecutable aceptan `--threshold` con **0.25, 0.15, 0.10 o
0.05**. Se acepta también la forma canónica 0.1. No se aceptan exponentes,
espacios, signos, otros valores, argumento faltante ni opciones duplicadas.
Omitir la opción conserva .25 y los argumentos anteriores. Cada invocación
crea un proceso, spotter y stream nuevos. No hay setters durante captura.

Se aplican antes de CreateKeywordSpotter tanto keywords_threshold como el `#`
de la línea de keyword, que puede sobreescribir el valor global. La keyword sigue
siendo `▁a t la s`, score=1, beam=4, cooldown=1000 ms, featureDim=80,
trailingBlanks=1. No cambian modelo, tokens, WASAPI, canal 0, FIR ni colas.

configuration.threshold contiene el nominal solicitado. thresholdEvidence registra
el float32 pasado al spotter; .15/.1/.05 no son exactamente representables.
El supervisor exige `Math.fround(solicitado)`, configuración exacta y SHA-256 de
la línea de keyword correspondiente. No reutiliza el hash de #0.25 para #0.15.
Reportes antiguos .25 sin esa evidencia siguen siendo legibles; para otros valores
es obligatoria. Los hashes de pesos/tokens/runtime y todos los locks se verifican
como antes. Cambiar la fuente Native invalida el lock: **recompilar**, sin editarlo.

El benchmark Offline y replay Native/WASM continúan fijados a .25, tres hits y
64 Decode. `--replay` con otro threshold se rechaza antes de ejecutar: no se cambia
WASM ni se reutiliza su expectativa acústica como si fuese independiente del umbral.

## Compilación y preflight Windows x64

Desde la raíz, Developer PowerShell x64 con herramientas ya instaladas:

```powershell
$sdk = (Resolve-Path '.local\wake-word-spike\native-sdk\v2.0.0-win-x64-shared-MD-Release-no-tts-audit\extracted\sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts').Path
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-live-sensitivity'
& .\experiments\wake-word\build-native-reference.ps1 -SdkRoot $sdk -OutputDir $out -Live
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
$exe = Join-Path $out 'native-live.exe'
$lock = Join-Path $out 'native-live-lock.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 --threshold 0.15 --check
if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT_FAILED' }
```

La carpeta de salida debe ser nueva. No descargar SDK/pesos nuevos ni instalar
dependencias. Todos los reportes y anotaciones deben permanecer bajo .local.
En Linux faltan MSVC, micrófono Windows, manifiesto/pesos/tokens/WAV; se prueban
parser, contrato y clasificación, sin afirmar compilación o reconocimiento real.

## Matriz manual, sin paralelismo

Por cada threshold ejecutar A, B y C, siempre **COLD, 60 s**. No automatizar
capturas ni superponer procesos. Mantener micrófono/alias local, formato, distancia,
idioma, volumen, ruido, plan energético y carga equivalentes. No aplicar ganancia
ni cambiar otros parámetros para conseguir mejores resultados.

| Ronda inicial | Orden de thresholds | Ensayos por threshold |
|---|---|---|
| R1 | .25 → .15 → .10 → .05 | A → B → C |
| R2 | .05 → .10 → .15 → .25 | A → B → C |

Son 24 ensayos secuenciales. Esta primera comparación no sustituye pruebas
prolongadas, más hablantes/acentos, distancias o ruido representativos.

| Caso | Procedimiento | Anotación |
|---|---|---|
| A / VOICE | 20 «Atlas», separar ~2.5–3 s, empezar tras ~2 s y dejar contexto al final | Marcar inicio y fin reales de cada pronunciación; contar intentos exactos |
| B / SILENCE | No hablar durante 60 s | Cero ventanas; todos los hits son falsos positivos |
| C / SIMILAR | 20 palabras/expresiones que no sean Atlas | Marcar cada control por ID numérico; todos los hits son falsos positivos |

Ejemplos de controles estáticos: «altas», «alas», «atleta», «atrás», «aulas»,
«hablas», frases cotidianas y otras palabras sin la keyword. Elegir de antemano
una lista de 20 y conservarla entre umbrales. No guardar lo pronunciado en los
archivos de anotación: sólo IDs y tiempos. Registrar falsos positivos también
fuera de esas ventanas, no sólo asociados a una palabra de control.

## Anotar ventanas sin grabaciones

Hay dos procesos de terminal independientes. **No escribir comandos de anotación
en el terminal Native**: allí Enter significa Stop. El anotador no tiene conexión
con la captura y no solicita micrófono.

1. En terminal B, antes de iniciar Native, preparar un nombre nuevo de reporte.
   Por ejemplo, para R1, threshold .15, prueba A:

```powershell
$out = Join-Path (Get-Location) '.local\wake-word-spike\native-live-sensitivity'
$report = Join-Path $out 'r1-t015-A.json'
$annotations = Join-Path $out 'r1-t015-A.annotations.json'
node --import tsx experiments/wake-word/native-sensitivity.ts annotate $report VOICE |
  Set-Content -Encoding utf8 $annotations
```

2. En terminal A (con exe/lock definidos), iniciar una sola captura:

```powershell
$report = Join-Path $out 'r1-t015-A.json'
node --import tsx experiments/wake-word/native-live.ts $exe $lock COLD 60 --threshold 0.15 --detail |
  Set-Content -Encoding utf8 $report
$trialExit = $LASTEXITCODE
```

3. En B, al observar CAPTURE_STARTED en A, introducir `start` y Enter. Antes de
   cada pronunciación introducir `b` y Enter; después, `e` y Enter. No escribir
   palabras, transcripciones ni nombres de dispositivos. Para SILENCE, sólo start.
4. Tras terminar la captura y cerrar el reporte, revisar el número de ventanas y
   la alineación (stderr muestra closedWindows y openWindow); introducir `confirm` únicamente si esa revisión es satisfactoria.
   Si no puede confirmarse, cancelar y repetir con nombres nuevos. No ajustar
   retrospectivamente ventanas para que coincidan con hits.
5. El anotador emite JSON numérico con reloj relativo, intentos reales y SHA-256
   de los **bytes exactos** del reporte. Rechaza un nombre de reporte ya existente
   al empezar. Modificar el reporte después invalida el vínculo. Sólo la redirección
   explícita guarda los JSON; no se almacena PCM ni texto conversacional.

El reloj del anotador es un cronómetro **alineado manualmente** al aviso observado,
no un reloj de hardware sincronizado. Las ventanas se expresan como milisegundos
aproximados del audio procesado, desde la primera muestra. Hay error humano,
entrega del aviso, inicio WASAPI y retardo FIR; no se demuestra un límite temporal
sólo con este cronómetro. Si el inicio se observó tarde, hay desfase evidente o
la alineación no es razonable dentro del margen previo de 250 ms, no confirmar.
Los resultados son estimaciones por ventanas manuales, no ground truth acústico.

Alternativa con notas temporales ya tomadas durante la prueba:

```powershell
node --import tsx experiments/wake-word/native-sensitivity.ts template $report VOICE |
  Set-Content -Encoding utf8 (Join-Path $out 'template.annotations.json')
```

La plantilla tiene reviewed=false, alignmentConfirmed=false y windows vacías.
Completar a mano sólo tiempos realmente observados, IDs consecutivos, attempts
igual al número real y flags de revisión; sin anotaciones previas hay que repetir
el ensayo. Ejemplo estructural de una ventana (no copiarlo como dato real):
`{"id":1,"startMs":2100,"endMs":2600}`. No incluir transcripciones/otros campos.
VOICE y SIMILAR exigen 20 ventanas para cumplir el protocolo; SILENCE exige cero.

## Analizar

```powershell
node --import tsx experiments/wake-word/native-sensitivity.ts analyze $report $annotations |
  Set-Content -Encoding utf8 (Join-Path $out 'r1-t015-A.analysis.json')
```

Repetir para B (kind SILENCE), C (SIMILAR), los cuatro thresholds y ambas rondas,
con nombres únicos. El analizador no ejecuta motores ni toca el reporte original.
Sólo admite archivos locales ignorados. Revalida identidad/configuración, evidencia
float32, hash de keyword y contrato Native, sin omitir controles de transporte.
Comprueba formato de hashes de pesos; el reporte no está firmado: su validación
autoritaria se hizo en preflight con el manifiesto. Comparar los cuatro hashes de
pesos/tokens y el formato efectivo entre ensayos; no mezclar identidades/condiciones.

Margen fijo, igual para todos: **250 ms antes del inicio y 1000 ms después del fin**
de cada ventana. No se modifica por threshold. Se usa audioSampleEnd/16 como posición
del hit: granularidad de bloque de hasta 100 ms y contexto del decoder. No se usan
startTime/timestamps del decoder como reloj global después de resets.

- Reconstituye cooldown con block*100 ms, igual que Feed, y exige que los conteos
  coincidan con detecciones/supresiones del reporte.
- Una pronunciación cuenta una sola vez si tiene al menos un hit aceptado dentro
  de su ventana ampliada. Un rawHit suprimido no recupera un intento omitido.
- Hits aceptados adicionales en esa ventana son duplicados. Los rawHits repetidos,
  incluidos suprimidos, se muestran por separado.
- Un hit fuera de ventanas es falso positivo; los controles consideran todos los
  hits falsos, incluso los que caen dentro de ventanas de palabras similares.
- Si un hit puede corresponder a dos ventanas, el estado es NEEDS_REVIEW y no se
  calcula sensibilidad. No se elige automáticamente la ventana más cercana.
- Un reporte cancelado/fallido queda EXCLUDED. Anotaciones sin revisar, cambios
  de archivo, cuentas inconsistentes o ventanas inválidas bloquean clasificación.
- sensitivityEstimate = ventanas con detección aceptada / intentos anotados,
  nunca rawHits / intentos. El reporte conserva rendimiento, memoria, cleanup,
  eventos numéricos y contabilidad de FP/omisiones/duplicados.

## Criterios y comparación final

Un caso A cumple el umbral experimental si tiene 20 intentos, asociación >=90 %,
sin duplicados aceptados ni rawHits fuera de ventanas. B/C deben tener cero rawHits.
Todos deben completar 60 s, cero overruns/saltos/errores de secuencia/pérdidas,
primera Decode y máximo bloque <200 ms, RTF <.7 y cleanup completo. Los mismos
controles Native siguen vigentes. Revisar aparte la discontinuidad inicial y la
memoria: no hay aprobación automática por un indicador numérico favorable.

Para cada threshold comparar en ambas rondas: asociación, omisiones, duplicados,
FP de A/B/C, primera Decode, p95/máximo Decode, máximo bloque, RTF, highWater,
edad de cola, memoria residente/pico/ventanas y cleanup. Marcar todo ensayo
incompleto y excluir el threshold si falla transporte/cleanup hasta investigarlo.
No escoger sólo el que produzca más hits ni mezclar formatos de captura distintos.

meetsTrialCriteria es sólo una comprobación por ensayo. No aprueba un threshold
aislado: hacen falta A/B/C y ambas rondas coherentes, sin ambigüedades, memoria
estable y revisión humana. Cero FP en dos minutos de silencio no demuestra una
tasa baja para ocho horas. Tampoco un hablante valida precisión general.
Si ninguno cumple, informar NO-GO sin cambiar score/modelo/tokens/arquitectura.

Los tests de datos sintéticos validan la lógica de clasificación, no reconocimiento
real. GO únicamente para revisión y aceptación experimental Windows. Sin integración,
escucha productiva, commit ni push en este checkpoint.
