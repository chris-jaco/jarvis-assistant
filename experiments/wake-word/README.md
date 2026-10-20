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
