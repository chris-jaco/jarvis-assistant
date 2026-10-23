# Atlas: spike experimental de wake word local

Evaluación personal aislada. No forma parte de Atlas Desktop, Atlas Web ni sus
paquetes. No conecta con Realtime. No es un motor aprobado para integración.

## Preparación y prueba en Windows 11

Desde la raíz del repositorio, con las dependencias de desarrollo existentes,
Node >=22.12 y `tar` de Windows disponibles:

```powershell
node experiments/wake-word/prepare.mjs
node experiments/wake-word/server.mjs
```

Abrir `http://127.0.0.1:4317` en Edge o Chrome. Primero pulsar **Cargar motor**;
esto verifica hashes e inicializa WASM sin abrir el micrófono. Después elegir
escenario y pulsar **Activar micrófono**. Decir «Atlas», con pronunciación española
y luego inglesa, anotando los intentos manualmente. Las dos pruebas usan siempre
el modelo español; mayúsculas/minúsculas en sus tokens no representan dos modelos
fonéticos ni garantizan pronunciación inglesa.

**Detener** finaliza los tracks, desconecta el grafo, cierra AudioContext y
termina el worker. Comprobar `tracks terminados: true` y que desaparece el
indicador del micrófono del navegador. Volver a cargar explícitamente para otro
ensayo. Ocultar la pestaña, cambiar de dispositivo o perder el micrófono detiene
el ensayo; no hay escucha persistente, reactivación ni reconexión automática.
No abrir simultáneamente la voz de Atlas durante la prueba.

La preparación requiere Internet para npm y Hugging Face. La escucha no descarga
nada: el servidor conserva los assets verificados en memoria; página y worker
bloquean APIs de red al empezar a escuchar. CSP limita además las conexiones al
origen local. Se puede desconectar Internet después de cargar el motor y antes
de activar el micrófono. La inspección Network del navegador debe mostrar cero
solicitudes durante la escucha. El servidor sólo acepta GET de rutas fijas en
loopback: no existe endpoint para subir audio.

En entornos que requieren el proxy configurado, Node 24 permite
`node --use-env-proxy experiments/wake-word/prepare.mjs`. Esto utiliza la
configuración existente; no cambiar proxies ni eludir políticas de red.

## Procedencia, revisión y licencias

- Modelo: [jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08](https://huggingface.co/jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08).
  Revisión corta observada: `b55eae7`. Preparación exige resolverla a un SHA de
  40 caracteres y descarga únicamente URLs de ese SHA. El SHA completo y hashes
  SHA-256 individuales quedan en `.local/wake-word-spike/manifest.json`.
- Se selecciona encoder/decoder/joiner ONNX fp32 `epoch-20-avg-2-chunk-16-left-64`,
  `tokens.txt` y `bpe.model`. Audio mono PCM float32 a 16 kHz. Se valida estructura
  protobuf/ONNX y se generan tokens ASCII de `atlas`/`ATLAS` desde SentencePiece;
  la compatibilidad efectiva exige inicializar el modelo real en WASM.
- El encabezado de la tarjeta declara Apache-2.0, pero su sección de licencia
  describe una licencia sugerida y remite a condiciones/atribuciones de voces
  Piper. **La licencia de redistribución de los pesos no está verificada.**
  No se encontró una prohibición explícita de evaluación local en la tarjeta
  consultada; la evaluación personal fue autorizada por el propietario. Si una
  revisión de los términos prohíbe esa evaluación, detenerse. Apache-2.0 del
  código no prueba la licencia de los pesos.
- Runtime: [@sherpaw/kws 0.3.0](https://www.npmjs.com/package/@sherpaw/kws),
  wrapper comunitario de sherpa-onnx; [fuente](https://github.com/sumimakito/sherpaw).
  Su paquete incluye LICENSE Apache-2.0. Se utiliza únicamente el entrypoint
  `core`, su glue autocontenido y WASM, sin instalar el paquete en el proyecto.
  La atribución completa de componentes transitivos del binario deberá revisarse
  antes de cualquier distribución; este spike no autoriza redistribución.

Todos los assets, copias de README/LICENSE y reportes viven exclusivamente en
`.local/wake-word-spike`, ya ignorado por Git. No se cambia el manifiesto oficial
de empaquetado. No copiar estos assets a public, dist, release o al repositorio.
Los hashes detectan modificaciones posteriores a la preparación; los hashes
calculados localmente no son una firma del autor. Cuando Hugging Face aporta
SHA-256 LFS se contrasta también con éste. La tarjeta descargada se conserva para
revisión local. No se cambia silenciosamente de modelo si la preparación falla.

El tarball del runtime está fijado con SHA-512:

```text
gT9UJs/zf2/TuvDTStka4rGymENqTVkF4a5IKaaHaURax1dmTtBlZDj5CTurnXBCYTSGamlUG9Nc8rr56UX3PQ==
```

Assets del runtime verificados durante este spike:

| Archivo bajo runtime/ | SHA-256 |
| --- | --- |
| core.js | `1d15f28cc04e7862dee28fda549c28e7e52456970afd9d10035c4696c78b246f` |
| wasm-CP0rq9dg.js | `122c98b161abd39a6ff11dc6c5bfcb0ecbcd334ddb66e4e96065fb944bf05596` |
| prebuilt/kws.wasm | `b75814d1f900cc99efc7de51ae561ffb2517456307488ec4387689c953b9b983` |
| LICENSE | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| package.json | `99afe404c4ebf30041a7dac2f353cfc4482d8d66ee745d2ca8f4afaf306251ca` |
| README.md | `fc27cf54929e4cbe0f60aed08a4ae9ceca44da613919ca542db7adfcf382cc7a` |

## Arquitectura y límites

`prepare.mjs` es la única pieza con descargas. `server.mjs` sirve una lista fija
de archivos en 127.0.0.1 y transpila con esbuild ya disponible en las herramientas
de desarrollo del repositorio. No hay dependencia productiva nueva, addon de
Electron ni Python.

`browser.ts` controla permisos y recursos. AudioWorklet reúne bloques mono de
100 ms y los transfiere directamente al worker mediante MessageChannel, sin
confirmaciones que dependan del hilo de interfaz. Hay exactamente cuatro buffers
reutilizables de 1600 muestras: 400 ms / 25600 bytes de PCM entre bloque parcial,
bloques en tránsito y buffers disponibles. El worker devuelve cada buffer puesto
a cero inmediatamente después de inferir. Se verifican secuencias y devoluciones
duplicadas; no se descartan bloques ni se hace crecer el pool. Al agotarse se
detiene el ensayo con contadores de producidos/pendientes. El grafo no se conecta
hasta confirmar que ambos extremos del canal están preparados. El worker carga
los pesos en MEMFS, ejecuta KWS
sincrónico y devuelve eventos Atlas y métricas escalares. `core.ts` permite
inyectar un motor en tests, valida PCM y coalesce detecciones durante un segundo.

El PCM de entrada se pone a cero tras procesarse; no se graba ni persiste.
El motor conserva en memoria el estado que necesita para inferencia. Detener
solicita liberar el motor y termina el worker aunque éste no llegue a procesar
la solicitud; por eso no se garantiza la ejecución del destructor individual
antes de terminarlo. La terminación libera todo su entorno. No se promete borrado
forense de RAM administrada por navegador/OS. Los errores de interfaz son códigos
cerrados; los logs JS del runtime en el worker se suprimen.

Esto no modifica la captura de micrófono ni lifecycle de Atlas. La prueba exige
ventana visible y parada manual; no demuestra comportamiento en Tray o sesiones
Realtime, que quedan fuera de alcance.

## Evidencia disponible y aceptación pendiente

En cloud se verificó compilación e inicialización del WASM real, exports KWS y
MEMFS. El heap inicial reservado fue **536870912 bytes (512 MiB)**; esto no equivale
a RAM residente ni a consumo total del navegador. El modelo español **no pudo
descargarse**: Hugging Face fue rechazado por la política de red del entorno
(`Tunnel connection failed: 403 Forbidden`), incluso con permiso de red. No se
modificó el proxy. No hay SHA completo ni hashes de pesos medidos en este entorno.
El servidor bloquea la carga del motor sin un manifiesto preparado y verificado.

Los tests con motores inyectados, protobuf sintético, protocolo worker y worklet
no prueban reconocimiento acústico. El propietario confirmó después la carga del
modelo y motor en Windows 11; la primera captura terminó con AUDIO_OVERRUN
(ver diagnóstico al final). La ruta corregida y el reconocimiento real siguen
pendientes de aceptación Windows. **NO-GO para integrar con Atlas** hasta
completar preparación, compatibilidad, revisión y aceptación acústica.

Registrar manualmente al menos 100 intentos, distribuidos entre ES-AR, ES-ES y
pronunciación inglesa; distancias 0.5/1/3 m; silencio y ruido. Incluir palabras
similares, música/TV y detecciones repetidas. Anotar intentos, aciertos, falsos
positivos, dispositivo, Windows/navegador, revisión y hashes. Evaluar por separado
cada pronunciación: objetivo inicial >=90 % para al menos una pronunciación
natural consistente. Añadir ocho horas representativas de negativos con ventana
visible: objetivo <=1 activación no deseada. El cooldown debe constar en el reporte
porque puede ocultar activaciones muy próximas.

La interfaz muestra inferencia p95, trabajo del worker p95, máximo de bloques
pendientes (hasta cuatro) y proporción de tiempo
de inferencia/audio. **Ninguna mide latencia desde el final acústico de la palabra,
CPU del sistema ni precisión.** Para el objetivo acústico p95 <500 ms se necesita
una referencia temporal externa documentada (por ejemplo, vídeo de prueba consentido
con voz y cambio visual) y cálculo separado. El harness no genera esa grabación.
Medir CPU y working set en Administrador de tareas contra baseline del mismo
navegador antes de cargar, motor listo y escucha prolongada. Verificar después de
Detener liberación del micrófono y desaparición del worker. Mantener Network
abierto y comprobar ausencia de tráfico durante escucha también sin Internet.

## Validación del código

```powershell
node --import tsx --test src/client/wake-word-spike.test.ts
npm test
npm run desktop:build
npx tsc -p experiments/wake-word/tsconfig.json
git diff --check
```

`desktop:build` incluye typecheck, Web, Core, extensión, Desktop y preload. No
genera ni ejecuta instaladores. El tsconfig separado comprueba el harness de
navegador sin incorporarlo a los builds oficiales.

## Repetir AUDIO_OVERRUN en Windows

La primera prueba Windows comunicó modelo y motor cargados, 16 bloques,
0 detecciones, inferencia p95 3.6 ms y entrega p95 6.0 ms. Estos datos no prueban
sobrecarga del motor: la versión anterior requería un crédito devuelto vía UI
antes del siguiente bloque de 100 ms. Una ráfaga del renderizador o una demora
puntual de esa ruta disparaba el error incluso con inferencia rápida. El contador
sólo incluía bloques procesados; el tiempo medido empezaba después de que el
bloque llegara a la página, y excluía esperas anteriores. No se dispone de una
traza Windows para atribuir aquella demora a un componente concreto.

La corrección elimina la UI de la ruta de audio/reciclaje y añade el pool fijo
anterior. Sus 400 ms son capacidad de audio, no una garantía de tolerancia de
400 ms de reloj: el navegador puede renderizar en ráfagas. No hay resampler propio;
el navegador convierte el dispositivo al AudioContext de 16 kHz, cuya frecuencia
se comprueba antes de conectar el grafo. Captura física puede comenzar durante
el permiso, pero la escucha analizada sólo empieza al conectar el grafo preparado.
No se promete preservar audio pronunciado antes de ese momento. No hay descarga
ni inicialización del modelo durante escucha.

Con los assets ya preparados, ejecutar sólo `node experiments/wake-word/server.mjs`
y recargar la página. Cargar motor, activar y dejar en silencio 5 minutos; decir
«Atlas» varias veces separado por al menos 2 segundos. Registrar bloques,
máximo pendientes/4, inferencia p95, trabajo worker p95 y cualquier error. Cambiar
la carga de CPU con uso normal del equipo para evaluar demoras; no ocultar la
página, pues eso detiene intencionalmente el ensayo. Si se agota el pool, registrar
producidos/pendientes del estado: no continuar una muestra acústica que terminó
con overrun ni sumar sus métricas a la siguiente.

Detener y verificar tracks terminados, indicador de micrófono apagado y worker
finalizado. Repetir cargar/activar/detener cinco veces; probar doble clic en Activar
y cancelar durante el permiso del micrófono. No debe haber capturas duplicadas
ni tracks residuales. Verificar también la parada por ocultar la pestaña. Las
pruebas automatizadas ejercitan ráfagas, bloqueo temporal del consumidor, orden de
muestras, límite del pool y liberación con adaptadores; la nueva ruta real Windows
y la precisión siguen pendientes de aceptación manual.

## Diagnóstico de threshold y saturación (sin PCM)

La nueva evidencia Windows relaciona threshold <0.25 con AUDIO_OVERRUN; todavía
no demuestra causalidad. En el código upstream consultado de
[TransducerKeywordDecoder](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/transducer-keyword-decoder.cc),
`ys_prob >= matched_state->ac_threshold` se evalúa al aceptar un keyword, junto
con trailing blanks. La selección TopK usa `max_active_paths`, no ese threshold.
No es un porcentaje calibrado de confianza ni un ajuste directo del tamaño del
beam. Cambiar aceptación cambia resets e historia de decodificación y puede
alterar indirectamente el trabajo. Esta lectura del upstream actual no acredita
la revisión C++ exacta compilada dentro del WASM comunitario 0.3.0; su paquete
no proporciona esa correspondencia completa. El glue JS descargado sí se auditó:
serializa cada secuencia con `:score #threshold @id`, procesa el stream y hace
reset tras cada detección aceptada, antes de que el harness aplique cooldown.

La configuración informada al quedar LISTO es la enviada al constructor del
motor: threshold efectivo para esa carga, score=1, maxActivePaths=4, cooldown=1000
ms, tokens del manifiesto y revisión del modelo. No es una lectura de retorno de
la configuración C++ ni de probabilidades. Modificar el input después de cargar
no altera el motor. `atlas` y `ATLAS` son variantes ortográficas del modelo
español, no selectores de pronunciación española/inglesa. El codificador
SentencePiece es simplificado; confirmar los tokens frente al tokenizer original
sigue siendo una comprobación independiente pendiente.

El panel Diagnóstico muestra solamente configuración de keyword y métricas:

- `engineMaxMs`: máximo de inferencia de todos los bloques completados de la
  sesión. El p95 de la interfaz sigue usando los últimos 1000 bloques.
- `beforeRecycleMaxMs`: máximo desde entrada al handler del worker hasta antes
  de postear la devolución; incluye validación, inferencia y limpieza del PCM.
- `recyclePostMaxMs`: coste máximo de la llamada postMessage de devolución.
  **No equivale al tiempo hasta que AudioWorklet recibe el buffer.**
- `withHits`/`withoutHits`: cantidad de bloques y máximo de inferencia según
  tengan hits aceptados por el runtime. No son candidatos rechazados ni una
  medida aislada del coste de reset.
- `rawHits` y `suppressedHits`: hits aceptados por el runtime y luego descartados
  por cooldown. No se cambió el cooldown ni la política de detección.
- Transporte: producidos, devueltos, pendientes, máximo pendientes y hasta 16
  eventos numéricos de envío/devolución. `returnAudioMaxMs` y `oldestAudioMs`
  miden edad según muestras procesadas, a 16 kHz. El reloj de audio puede avanzar
  en ráfagas: **no se debe interpretar como tiempo de reloj de pared**.
- `returnWallMaxMs` y `oldestWallMs` usan performance.now en el propio worklet
  sólo si ese reloj está disponible. En caso contrario son null, no cero.
- Al fallar, se conserva el snapshot del pool y el último inicio de bloque
  observado por la UI. `sinceStartObservedMs` compara relojes performance con
  timeOrigin y también incluye demoras de entrega a la UI. No prueba cuánto
  tiempo ejecutó CPU el worker.

La UI conserva el último snapshot completado del worker. Una inferencia que
queda bloqueada y se termina al parar puede no devolver duración final: no
presentar su tiempo como medido ni retrasar liberar el micrófono para obtenerlo.
La telemetría del transporte se envía cada 10 devoluciones y siempre al fallar;
los historiales están limitados a 16 eventos sin PCM, transcripciones, rutas de
usuario ni mensajes crudos. No se guarda ni exporta automáticamente ningún dato.
Copiar manualmente el panel después de Detener o AUDIO_OVERRUN. Se añade un
mensaje escalar al iniciar cada bloque; la instrumentación tiene coste y debe
mantenerse igual al comparar thresholds.

No hay ajuste de buffers ni de inferencia en esta instrumentación. El pool sigue
siendo de cuatro buffers; ante agotamiento se detiene explícitamente y libera
recursos. Una causa plausible es una cola de latencias largas/ráfagas, ausente de
la estadística p95 anterior, eventualmente relacionada con más hits y resets.
No se debe afirmar que bajar threshold aumenta necesariamente candidatos o CPU.

Prueba Windows controlada:

1. Usar este mismo harness, modelo/revisión, micrófono, distancia 0.5 m y ES-AR.
   Cerrar otras capturas de micrófono y mantener la página visible.
2. Probar secuencia de thresholds **0.25 → 0.15 → 0.25 → 0.05 → 0.25**.
   Detener, cambiar threshold y volver a cargar el motor en cada serie; comprobar
   la configuración del panel. Repetir en orden inverso para separar efecto de
   orden, calentamiento, temperatura y carga del equipo.
3. En cada serie dejar 30 s de silencio, hacer 20 intentos de «Atlas» uno cada
   4 s y terminar con 30 s de silencio. No cambiar score, tokens ni cooldown.
4. Anotar intentos/aciertos, hits brutos/suprimidos, máximos, configuración y
   snapshots del panel. Si falla, registrar en qué fase, no continuar el ensayo
   ni ocultar el fallo sumando los resultados al siguiente.
5. Si falla también en silencio sin hits, no atribuirlo a procesamiento de
   eventos de detección. Si picos coinciden con hits/reset, priorizar analizar
   esa ruta; si aumenta la circulación sin picos del worker, analizar scheduling
   y devoluciones. La correlación de bloques no sustituye una traza temporal.
6. En el mejor ajuste estable, añadir negativos con conversación sin la palabra,
   palabras parecidas, música y TV; la validación prolongada de falsos positivos
   y los 100 intentos independientes siguen pendientes.

No reducir capturas a un umbral permanentemente restrictivo para ocultar fallos,
no descartar PCM ni ampliar el pool sin un presupuesto y evidencia. La corrección
mínima de rendimiento se decidirá con estos datos; esta etapa corrige la falta
de observabilidad y mantiene la parada segura.

## Acoustic Pipeline Diagnostics: señal y WAV local

No cambia la selección de canal, keyword, score, threshold, cooldown ni el pool.
El diagnóstico añade `capture` con frecuencia/channels del track cuando el
navegador los proporciona, frecuencia del AudioContext y DSP efectivo. No incluye
labels, deviceId ni groupId. Una frecuencia del dispositivo de 48 kHz junto a
AudioContext de 16 kHz es válida: el navegador hace esa conversión.

`worker.signal` y los últimos 16 bloques numéricos muestran RMS, peak absoluto,
porcentaje de muestras con |x| <= 1e-5, conteo con |x| >= .999 y muestras inválidas.
El RMS agregado pondera energía por cantidad de muestras, no promedia RMS de
bloques. Son indicadores orientativos:

- DIGITAL_SILENCE: RMS cero; LOW_LEVEL: RMS menor a .001 (aproximadamente -60 dBFS).
- NEAR_FULL_SCALE: muestras próximas al máximo; no demuestra clipping físico.
- INVALID_PCM: no finitos o fuera de [-1,1]; UNEXPECTED_CHANNELS/RATE y
  INCOMPLETE_BLOCK describen el formato observado.

Estos indicadores no normalizan ni reparan señal y no añaden paradas por nivel
bajo/clipping/canales. Las validaciones previas de PCM no finito/fuera de rango,
protocolo y agotamiento se preservan: un bloque inválido no se entrega a WASM ni
se descarta silenciosamente para continuar como si no hubiera ocurrido.

AudioWorklet informa los canales de entrada de cada bloque; si cambian dentro
un bloque informa cero como ambiguo. **Se sigue enviando el canal 0**, tal como
antes: no se introdujo downmix en la captura. En una prueba sintética, canal 0
silencioso + canal 1 con señal entrega silencio. Esto demuestra una limitación,
no que la captura Windows haya sido estéreo. Revisar canales y RMS antes de
proponer un cambio de selección o negociación de mono.

### Preparar y ejecutar el WAV

El WAV debe existir por decisión del usuario. No hay grabación automática ni
endpoint de subida. Colocarlo manualmente bajo `.local` (ya ignorado por Git),
por ejemplo `.local/wake-word-spike/audio/atlas-autorizado.wav`. Los symlinks se
resuelven; se rechazan archivos que resuelvan fuera de `.local`. No añadir audio
ni modelos al repositorio o a builds oficiales.

Desde la raíz del repositorio en Windows, con assets previamente preparados:

```powershell
node --import tsx experiments/wake-word/offline.ts --audit-only
node --import tsx experiments/wake-word/offline.ts .local/wake-word-spike/audio/atlas-autorizado.wav --threshold 0.05
```

El threshold debe coincidir con la prueba de navegador; el default sigue siendo
0.25. Modelo, revisión, hashes y keywords se toman del mismo manifest verificado.
Score=1, maxActivePaths=4, cooldown=1000 ms. Se valida RIFF/WAVE sin compresión:
PCM16 LE o IEEE Float32; se rechazan headers/chunks inconsistentes, muestras
inválidas y formatos extensibles/comprimidos. Límite: 32 MiB y cinco minutos.
Preferir PCM16, mono, 16 kHz para la primera prueba y para comparar referencias.

Si el WAV requiere conversión, autorizarla explícitamente:

```powershell
node --import tsx experiments/wake-word/offline.ts .local/wake-word-spike/audio/atlas-autorizado.wav --threshold 0.05 --convert
```

PCM16 se divide por 32768. La conversión opcional promedia canales y aplica un
filtro Hann-sinc determinista de 64 taps para 16 kHz; no compensa ganancia ni
recorta picos. Canales en contrafase pueden cancelarse. Overshoot fuera de rango
se rechaza, no se normaliza. Se informa la conversión y SHA-256 del WAV original
y del PCM float32 LE canónico. El audio convertido existe sólo en RAM; no se
escribe. Esta conversión offline no sustituye la del navegador ni demuestra
igualdad bit a bit con su resampler.

Se transfieren las muestras a un worker Node dedicado y se entregan bloques
ordenados de 1600 muestras; el último parcial conserva su longitud. No se añade
silencio ni se llama InputFinished. Preparar el WAV con un segundo inicial,
intentos conocidos y 1–2 segundos de silencio posterior a cada palabra. El worker
bloquea APIs web de red tras cargar el WASM local, libera el motor/heap y el padre
lo termina siempre, incluso en errores/timeout. No se instala Python ni un addon
Electron. El script imprime únicamente resultados numéricos, configuración de
keyword y hashes; errores cerrados sin rutas o mensajes nativos.

La reproducción corre tan rápido como permite el motor. El cooldown conserva
1000 ms pero usa posición de muestras para reproducibilidad, mientras que el
harness de micrófono usa reloj de ejecución. **Comparar referencias por rawHits**,
no por el contador visual afectado por cooldown. Eventos offline informan el
bloque/posición de entrada donde se obtuvo el hit, no latencia acústica exacta.
Los tiempos de inferencia no forman parte del resultado determinista. No comparar
este ensayo con otro audio o con silencio añadido artificialmente.

### Auditoría de «Atlas»

La secuencia reportada `▁a / t / la / s` reconstruye `▁atlas`; por sí sola no
prueba un defecto. `--audit-only` comprueba presencia de piezas en bpe.model,
tokens/IDs válidos y únicos en tokens.txt, reconstrucción de Atlas y opciones de
normalización (dummy prefix, espacios, mapa precompilado). No reemplaza keywords.
También muestra qué produciría el encoder simplificado existente.

STRUCTURALLY_CONSISTENT_REFERENCE_PENDING no es un PASS de tokenización canónica
ni de dimensiones del ONNX. Es necesario comparar con SentencePiece original de
la misma revisión, que no se ha instalado. El encoder actual sólo intenta ASCII
`atlas` y `ATLAS`; no ofrece normalización general de acentos/espacios. No añadir
«Átlas», frases o pronunciaciones alternativas para conseguir hits sin revisión.
INCOMPATIBLE/AUDIT_INVALID bloquea la prueba offline y exige revisar evidencia,
sin corregir automáticamente la keyword.

En cloud siguen faltando bpe.model, tokens.txt y pesos del modelo español. No se
pudo ejecutar la auditoría real ni un reconocimiento con WAV autorizado aquí:
`MODEL_ASSETS_UNAVAILABLE` es el resultado esperado hasta preparar esos assets.
Los tests sintéticos no validan pronunciación, modelos ni precisión.

### Referencia nativa opcional

La C API de sherpa-onnx permite los mismos pesos transducer. Se preparó
`reference-kws.cc`, un ejecutable standalone de diagnóstico, sin incorporarlo a
Atlas. Requiere un SDK/C API previamente disponible y compatible; **no se han
instalado bibliotecas ni compilado este adaptador en este entorno**. Registrar
revisión de sherpa-onnx/ONNX Runtime, flags y SHA-256 del ejecutable antes de usarlo.
Una diferencia de versiones/provider/kernel puede producir diferencias numéricas.

Su integración acepta sólo WAV original PCM16 mono 16 kHz, sin conversiones:

```powershell
node --import tsx experiments/wake-word/offline.ts .local/wake-word-spike/audio/atlas-autorizado.wav --threshold 0.05 --reference-exe C:\herramientas\atlas-kws-reference.exe
```

El helper pasa los mismos cuatro archivos verificados, las líneas
`▁a t la s :1 #0.05 @sherpaw_0` (o las secuencias reales del manifest), CPU/un hilo,
80 features, maxActivePaths=4 y trailing blanks=1. El adaptador alimenta los mismos
bloques, resetea tras hit y no añade silencio. Sólo se aceptan respuestas JSON
acotadas con cantidad de muestras/bloques esperada; no se muestran logs crudos.
No ejecutar un binario desconocido: debe ser el adaptador revisado y compilado
contra el SDK elegido. Su ejecución no se autoriza implícitamente al ejecutar
el modo WASM normal.

El CLI oficial consultado añade 0.8 s de silencio y llama InputFinished:
[fuente](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/sherpa-onnx-keyword-spotter.cc).
Por eso no se sustituye automáticamente por este adaptador ni se comparan sus
resultados como idénticos al streaming actual. Si no existe SDK/exe aprobado,
referencia NOT_CONFIGURED: comparación pendiente, no validación exitosa.

### Aceptación Windows del checkpoint

1. Micrófono: 10 s de silencio, 20 pronunciaciones ES-AR a 0.5 m y ritmo de una
   cada 4 s. Registrar RMS/peak por bloque y agregado, near-zero/clipping,
   canales/frecuencias, secuencias y transporte. Ningún identificador de dispositivo.
2. Si RMS no cambia al hablar o el canal está en silencio, investigar captura
   antes de variar threshold. Si hay dos canales, solicitar revisión antes de
   cambiar selección/downmix. No amplificar automáticamente para forzar detección.
3. Ejecutar auditoría de tokens y conservar resultados/hash. Resolver cualquier
   incompatibilidad demostrada antes de cambiar keyword o modelo.
4. Ejecutar dos veces el mismo WAV autorizado con iguales hashes/parámetros.
   Raw hits, posiciones y muestras deben coincidir. Repetir sin Internet.
5. Si existe referencia aprobada, comparar el mismo WAV canónico y configuración.
   Si funciona WAV pero no micrófono, priorizar captura; si sólo funciona nativo,
   priorizar runtime; si ambos fallan, priorizar tokens/modelo/acústica.
6. Detener/liberar tras prueba y error; confirmar tracks terminados y sin workers
   vivos. No declarar reconocimiento aprobado con mocks ni por tres hits aislados.

## Comparación del mismo WAV: Offline vs ruta Live

La evidencia Windows aportada para un WAV de 20.65 s/8 pronunciaciones es:
6 rawHits, 6 detecciones, cero supresiones, threshold .05, RMS .03135,
peak .54218, sin clipping ni PCM inválido, 207 bloques. Estos valores provienen
del propietario, no de una ejecución en cloud. Seis hits no demuestran seis
aciertos distintos: pueden incluir duplicados o falsos positivos. No se confirma
75 % hasta contrastar las posiciones con ocho ventanas anotadas previamente.

Diferencias demostradas entre las rutas anteriores:

| Tramo | Micrófono Live | Offline WAV |
| --- | --- | --- |
| Entrada | getUserMedia, dispositivo/Windows y DSP negociado | PCM del archivo autorizado |
| Canales | Se solicita mono; se usa el primer canal observado | Mono original o promedio explícito con --convert |
| Frecuencia | Conversión del navegador al AudioContext de 16 kHz | 16 kHz original o conversión Hann-sinc explícita |
| Tiempo | AudioWorklet/MessageChannel y cuatro buffers | Bucle síncrono sin reloj real |
| Cola final | Bloque incompleto se descarta al detener la captura | Se entrega la cola parcial exacta |
| Cooldown | 1000 ms de reloj de ejecución | 1000 ms de posición de muestras |
| Decoder | Mismo constructor, parámetros, stream persistente y reset tras hit | Mismo contrato con el wrapper Node/WASM |

La prueba nueva cambia sólo la **fuente de ensayo**: lee el archivo local en
memoria y transfiere sus muestras a AudioWorklet. Éste las produce en quanta del
renderizador, con el mismo pool fijo de cuatro buffers y el mismo canal directo
al worker Live. No usa getUserMedia, AudioBufferSource ni resampler del navegador.
No prueba aún la captura del dispositivo; sirve para aislar transporte/worker
antes de investigarla. No reproduce sonido audible.

Sólo en este modo de ensayo se declara la longitud válida del último buffer:
la cola de 800 muestras del WAV de 20.65 s llega al motor sin rellenarla con
silencio. El almacenamiento de transporte sigue siendo de cuatro buffers de
1600 muestras. La política del micrófono no se cambia. Al EOF se espera que todos
los buffers se devuelvan **y** que llegue la última telemetría del worker, aunque
los mensajes crucen por puertos distintos. Sólo entonces se informa COMPLETED y
se libera worker/AudioContext. Stop, overrun, suspensión o error producen una
prueba incompleta; no se convierten en éxito ni se reintentan.

El informe WAV incluye SHA-256 del archivo y del PCM fuente, muestras/bloques,
RMS/peak agregado y posiciones de rawHits por bloque. Se calcula además FNV-1a de
los float32 LE que realmente recibió el worker. Es una huella diagnóstica, **no
una prueba criptográfica de igualdad**. Coincidencia de fuente SHA-256, orden,
conteo, huella y métricas proporciona evidencia conjunta de continuidad. No se
almacena una segunda copia de PCM para calcular la huella ni se registra audio.
La posición de hit es el intervalo de entrada del bloque donde se obtuvo,
no el principio/final acústico exacto ni el timestamp de tokens del decoder.

### Procedimiento Windows

1. Usar exactamente el WAV autorizado fuera de Git. No cambiar volumen, modelo,
   tokens, score ni cooldown para esta comparación. Conservar su SHA-256.
2. Volver a ejecutar el Offline de esta versión para añadir la huella y posiciones
   al reporte. Usar threshold .05, como la ejecución original. Sólo si el ensayo
   original usó --convert, repetir también ese flag. Guardar **el JSON numérico**
   manualmente bajo `.local` si se desea seleccionarlo en la interfaz; no contiene
   PCM. No confundir ese reporte con una grabación.
3. Iniciar `node experiments/wake-word/server.mjs`, recargar la página y seleccionar
   .05 **antes de Cargar motor**. Confirmar el threshold del diagnóstico, no sólo
   el valor visible del input.
4. Seleccionar el mismo WAV en el campo local y el JSON Offline opcional. Por
   defecto se exige mono/16 kHz. Si el Offline usó --convert, marcar explícitamente
   su casilla; aplica el mismo lector/conversor ya existente, en memoria. Nunca
   se aplica ganancia o conversión para conseguir detecciones artificiales.
5. Pulsar **WAV → AudioWorklet → Worker**, mantener la pestaña visible y esperar
   `WAV_COMPLETO — sin micrófono`. El indicador de micrófono no debe encenderse.
   El navegador no puede verificar Git ignore desde el picker: el usuario debe
   elegir el archivo fuera de Git; no se sube a ningún endpoint del servidor.
6. Revisar `wav`, `comparison` y las métricas. Para 20.65 s a 16 kHz se esperan
   330400 muestras y 207 bloques, final de 800 muestras. Toda diferencia de
   configuración, SHA fuente o conversión invalida la comparación controlada.
   Reportes antiguos sin FNV muestran sameFingerprint=null: no afirmar coincidencia.
7. Repetir dos veces con un motor recién cargado en cada ejecución. Comparar
   rawHits y bloques de detección; el contador tras cooldown puede diferir por
   las distintas bases temporales. No ajustar el cooldown para hacerlos coincidir.
8. Para verificar 6/8, escuchar el WAV autorizado con una herramienta local elegida
   por el usuario y anotar **antes de evaluar** ocho ventanas de activación,
   una por pronunciación. Usar margen de contexto fijo y documentado. Introducir
   una ventana por línea, por ejemplo `0.5,2.0` (punto decimal). Se informa una
   correspondencia uno a uno provisional, duplicados, hits fuera de ventanas,
   ventanas sin hit y ambigüedades. Revisar manualmente; no ampliar ventanas a
   posteriori para forzar 75 %.
9. Si ambos modos coinciden, capturar después la configuración real del micrófono,
   canales, RMS/peak y resampling. Si difieren con muestras/configuración iguales,
   investigar scheduling, segmentación, versión del runtime y estado del decoder.
   No atribuirlo directamente al modelo ni aplicar ganancia.

En cloud no están este WAV ni los pesos españoles. La prueba sintética de 20.65 s
usa un motor inyectado: comprueba igualdad de muestras, posición y rawHits por la
ruta real de mensajes, no reconocimiento acústico. La comparación real de las
seis detecciones y las ocho pronunciaciones queda pendiente de Windows.

Para guardar el reporte Offline como UTF-8 explícito en PowerShell, por ejemplo:

```powershell
node --import tsx experiments/wake-word/offline.ts .local/wake-word-spike/audio/atlas-autorizado.wav --threshold 0.05 | Set-Content -Encoding utf8 .local/wake-word-spike/offline-comparison.json
```

Si se usó --convert en la referencia, conservarlo también en ese comando. Evitar
redirección UTF-16 de Windows PowerShell: el picker de JSON espera UTF-8. Los
índices de ventanas mostrados por el diagnóstico empiezan en cero (0–7).


## Estabilización WAV y diagnóstico de micrófono

La evidencia Windows nueva, a threshold .25, mostró igualdad Offline/Worklet:
3 rawHits en bloques 27, 46 y 91, 207 bloques, **330411 muestras**, FNV
`f5a0e491`, RMS/peak iguales y cero supresiones. No se ejecutó ese audio en cloud.
La duración 20.65 s estaba redondeada: para este archivo la cola real es de
**811 muestras**, no 800. Siempre usar el conteo del archivo, no una duración
redondeada para inferirlo.

El fallo reproducible de transporte era ausencia de backpressure de la fuente
WAV: se consumía el archivo al ritmo del renderizador aun con cuatro buffers
pendientes. Una pausa de scheduling, devolución tardía o inferencia lenta podía
agotar el pool aunque p95 fuese pequeño. Los datos disponibles no identifican
cuál de esas pausas ocurrió en cada ejecución Windows.

Ahora el archivo pausa su cursor cuando no hay buffer libre, incluso a mitad
de un quantum. Lo reanuda al devolver un buffer, conservando orden y longitud.
No crece el pool, no se descartan/duplican muestras y no se introduce silencio
al decoder. La salida del grafo continúa muda. `transport.wavBackpressure`
informa quanta y tiempo de render no consumido; el tiempo de pared puede superar
la duración del audio. No es una prueba de rendimiento Realtime ni de que el
micrófono soporte esas pausas. El micrófono sigue fallando explícitamente con
AUDIO_OVERRUN cuando no puede conservar audio real. El timeout finito previo
(duración del WAV + 30 s) sigue deteniendo/liberando una prueba incompleta;
no hay reintentos. Cooldown y sus bases temporales no se modifican: comparar
rawHits y posiciones antes de comparar detecciones filtradas.

### Aceptación Windows

1. Ejecutar `node experiments/wake-word/server.mjs` y abrir la dirección local
   indicada. Mantener la pestaña visible. Usar el mismo WAV local y reporte
   Offline UTF-8, el mismo modelo y .25 antes de cargar el motor.
2. Repetir WAV → AudioWorklet → Worker al menos diez veces, cargando un motor
   nuevo en cada intento. Confirmar ausencia de micrófono y de tráfico externo;
   330411 muestras/207 bloques, cola 811 y la misma huella, RMS/peak y rawHits
   en los mismos bloques. Registrar highWater, waitQuanta, waitRenderMs y máximos
   de inferencia/devolución. Un highWater de 4 ahora puede producir pausa WAV,
   no pérdida. Timeout, Stop o error deben informar INCOMPLETE y liberar recursos.
3. Para micrófono, seleccionar opcionalmente el mismo reporte Offline y cargar
   nuevamente el motor sin cambiar parámetros. Activar micrófono, medir unos
   segundos de silencio y luego un número conocido de pronunciaciones a igual
   distancia. Hacer ensayos separados para silencio y voz; sus proporciones
   afectan el RMS agregado. No se guarda ninguna grabación.
4. Revisar `capture`: frecuencia/canales reportados por el track, 16 kHz del
   contexto, DSP negociado y solicitud original. `resampling` señala diferencias
   reportadas; no verifica frecuencia física ni DSP interno del driver/Windows.
5. Revisar `transport.inputChannels` (totales escalares de hasta ocho canales
   observados en la entrada del worklet) y `worker.signal.lastBlock/aggregate`.
   Canal 0 sigue siendo la única entrada al motor. Si su RMS/peak es casi nulo
   mientras otro canal tiene señal, documentar el problema antes de cambiar la
   selección. `channelsTruncated` indica si hay más canales que los medidos.
   Los canales observados son los del grafo del navegador, no evidencia de los
   canales físicos originales del dispositivo.
6. `microphoneComparison` contrasta sólo RMS, peak, nearZero, clipping e inválidos
   con el reporte elegido. Ratios no prueban reconocimiento ni autorizan ganancia.
   Comparar también los bloques durante voz: un agregado bajo puede deberse a
   más silencio. Una señal no nula no demuestra por sí sola que sea voz útil.
7. Detener y verificar tracks terminados, AudioContext cerrado y Worker liberado.
   No deben existir sesiones duplicadas. No ajustar DSP, canales, ganancia,
   resampling, modelo ni umbrales para esta medición.

Los diagnósticos no imprimen deviceId, groupId, nombres de archivos/dispositivos,
PCM ni transcripciones. Sólo memoria de sesión; ninguna exportación automática.
Las pruebas sintéticas verifican continuidad bajo backpressure, no reconocimiento
acústico ni estabilidad real de Windows. Siguiente checkpoint: revisar estas
mediciones antes de cambiar la captura o integrar wake word.


## Traza temporal de micrófono (sin cambios de transporte)

La instrumentación conserva los cuatro buffers, transferencias directas, orden de
entrada, selección de canal 0 y parada fail-closed. No espera a la UI, no introduce
acks, reintentos, ganancia, downmix ni muestras sintéticas. Tiene coste de medición:
un mensaje escalar adicional por inicio de llamada al motor y snapshots acotados.
Comparar pruebas con la misma instrumentación y mantener la pestaña visible.

Por secuencia se registran estas fronteras:

| Frontera | Ubicación |
| --- | --- |
| Envío de audio | `transport.recent` evento send / `timing.pending[].sent` |
| Recepción en handler Worker | `worker.recent[].timing.received` |
| Inicio de llamada síncrona al motor | `worker.recent[].timing.inferenceStart`; también mensaje inmediato `inference-start` a UI |
| Retorno o excepción de esa llamada | `worker.recent[].timing.inferenceEnd` |
| Inicio de postMessage de devolución | `worker.recent[].timing.recyclePost` |
| Recepción de devolución | `transport.recent` evento recycle, campo received |

`worker.timing.history` conserva hasta 64 eventos con secuencia, etapa numérica,
localMs y epochMs. Etapas: 1=recepción, 2=inicio del motor, 3=salida del motor
(también si lanza excepción), 4=devolución posteada/bloque completado,
5=error de procesamiento. `lastReceived`, `lastStarted` y `lastCompleted` distinguen
el último handler recibido, llamada iniciada y bloque completado correctamente.
`diagnostics.timing` en UI conserva el snapshot del último inicio observado,
independientemente del último bloque completo disponible en `diagnostics.worker`.
El interior de WASM y los pasos individuales del decoder no se instrumentan.

El transporte conserva hasta 16 eventos send/recycle, hasta cuatro envíos
pendientes con sus timestamps, consumedSamples, producedSamples,
producedMinusReturned, renderQuanta y firstRender/lastRender/observed. renderFrame
y renderTimeMs vienen de currentFrame/currentTime del AudioWorklet; si no están
expuestos son null. Son reloj de audio, **no reloj de pared**. consumedSamples
cuenta sólo muestras aceptadas; los callbacks de render también pueden existir
sin entrada útil o durante pausa WAV. No inferir frecuencia física del dispositivo
sólo a partir de estos números.

### Relojes y límites

- localMs procede de performance.now del contexto correspondiente. Compararlo
  sólo dentro de ese contexto. AudioWorklet puede no disponer de performance.
- epochMs se calcula únicamente con performance.timeOrigin + performance.now
  cuando ambos existen. Es la base de tiempo comparable entre contextos del
  navegador; no se usa Date.now ni se inventa un offset. No se imprime el origen
  como dato separado ni identificadores de usuario/dispositivos.
- deliveryMs = recepción Worker menos envío worklet; returnDeliveryMs = recepción
  worklet menos inicio de postMessage de devolución. Sólo se calculan si ambos
  epochMs están disponibles; de lo contrario son null. Incluyen scheduling/colas
  y coste de transferencia, no distinguen por sí solos esas causas. La resolución
  reducida de timers puede introducir diferencias pequeñas o negativas: no se
  recortan para simular precisión ni se interpretan como latencia física exacta.
- `failure.inferencePendingObservedMs` mide desde el inicio del motor observado
  hasta atender el fallo en UI. `inferencePendingAtFaultMs` usa el timestamp del
  snapshot de fallo worklet, sólo si es comparable. Pueden ser null, estar sujetos
  a entrega tardía o representar un inicio ya obsoleto. Ninguno mide tiempo CPU
  ni demuestra que la llamada siguiera ejecutándose: los puertos no son atómicos.
- Al parar no se espera a terminar una inferencia ni a drenar diagnósticos. El
  micrófono se libera inmediatamente; los eventos no entregados pueden perderse.
  La falta de un evento no demuestra que la operación no haya sucedido.

### Procedimiento Windows

1. Ejecutar `node experiments/wake-word/server.mjs`. Cargar motor nuevo a .25,
   manteniendo modelo/keywords/parámetros originales. No abrir DevTools hasta
   después del primer ensayo para reducir interferencias; anotar navegador/versión
   y si DevTools estaba abierto, sin nombres ni IDs de dispositivos.
2. Ejecutar al menos tres ensayos separados en silencio y tres con pronunciaciones
   conocidas, sin cambiar DSP, canal o ganancia. Mantener visible la pestaña.
3. Tras AUDIO_OVERRUN o Detener, copiar manualmente el JSON numérico completo:
   failure, timing, transport y worker. No exportar grabaciones. Registrar si la
   limpieza terminó correctamente. No confundir ~302 ms de UI con duración total.
4. Para secuencias 4–7 comparar envíos pendientes, último inicio y último bloque
   completo. Una llamada iniciada sin fin observado y con gran duración pendiente
   prioriza llamada larga o descheduling durante ella; **no distingue CPU ocupada
   de Worker desplanificado dentro de la llamada**.
5. Si aumenta deliveryMs antes del inicio, priorizar cola/Worker ocupado. Si la
   devolución fue posteada pero returnDeliveryMs aumenta, priorizar scheduling o
   entrega hacia worklet. Sin epoch comparable, usar sólo orden, contadores y
   duraciones locales; no restar relojes locales de contextos distintos.
6. Comparar avance de renderFrame/renderTimeMs con tiempo de pared del worklet,
   cuando exista. Mucho audio producido en poco tiempo de pared apoya una ráfaga.
   Un snapshot de UI tardío por sí solo no la demuestra.
7. Repetir control WAV con mismos parámetros y comprobar huella/orden/muestras.
   Pausas WAV no prueban capacidad Realtime. No ampliar el pool ni cambiar
   semántica hasta localizar qué frontera acumula demora.

Pruebas de VM con reloj inyectado reproducen inferencia lenta, Worker sin atender,
colas de ida/vuelta, ráfagas, devoluciones fuera de orden y fallo dentro del motor.
No constituyen medición del navegador Windows ni reconocimiento acústico.
