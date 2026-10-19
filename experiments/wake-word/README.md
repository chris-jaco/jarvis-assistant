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
100 ms y los transfiere a un worker. Sólo se admite un bloque en vuelo; ante
saturación se detiene el ensayo. El worker carga los pesos en MEMFS, ejecuta KWS
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
no prueban reconocimiento acústico. Sigue pendiente ejecutar el modelo real y
verificar el navegador en Windows 11. **NO-GO para integrar con Atlas** hasta
completar preparación, compatibilidad, revisión y aceptación acústica.

Registrar manualmente al menos 100 intentos, distribuidos entre ES-AR, ES-ES y
pronunciación inglesa; distancias 0.5/1/3 m; silencio y ruido. Incluir palabras
similares, música/TV y detecciones repetidas. Anotar intentos, aciertos, falsos
positivos, dispositivo, Windows/navegador, revisión y hashes. Evaluar por separado
cada pronunciación: objetivo inicial >=90 % para al menos una pronunciación
natural consistente. Añadir ocho horas representativas de negativos con ventana
visible: objetivo <=1 activación no deseada. El cooldown debe constar en el reporte
porque puede ocultar activaciones muy próximas.

La interfaz muestra inferencia p95, entrega de bloque p95 y proporción de tiempo
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
