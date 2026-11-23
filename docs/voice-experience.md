# Evaluación vocal para Desktop y Android

La base empaquetada usa `gpt-realtime-2.1`, voz `cedar`, español para la transcripción y VAD semántico de sensibilidad media con interrupción. El cliente y el emisor configuran la sesión. La personalidad ya pide voseo rioplatense ligero, respuestas breves y una voz masculina. Esta última indicación es una variable para la prueba de escucha. Cambiar el timbre y el género preferido requiere escuchar alternativas. En Desktop el medidor comparte el track de WebRTC y el bridge espera el resultado autorizado de la herramienta antes del anuncio de éxito.

| Opción | Sonido, streaming e interrupción | Latencia, coste y datos | Integración y riesgo |
|---|---|---|---|
| OpenAI Realtime actual | Español y voseo configurables, diálogo dúplex y VAD existentes. Timbre y pronunciación se evalúan con oyentes. | Una sesión. Audio de entrada/salida por tokens. Medir fin de turno → primer audio reproducido y tiempo hasta silenciar en cada cliente. | Mantiene el bridge de confirmación y el contexto actual. Es la opción de V0.7. |
| OpenAI + TTS ElevenLabs | Permite elegir voz y expresividad. El cliente tendría que cortar TTS, vaciar audio pendiente y reconciliar lo que el usuario llegó a oír. | Acumula generación de texto, primer fragmento TTS, red y reproducción. Suma coste por texto sintetizado y comparte respuestas con otro proveedor. | Spike posterior sólo con frases sintéticas. Requiere coordinación en ambos clientes. Estimación de 3–5 días para medir una ruta aislada. |
| ElevenAgents | Turnos, modelos y streaming propios, SDK React Native con LiveKit y su propia integración WebRTC. El acento de una voz candidata tiene que probarse con el mismo guion. | Coste por conversación/plan y posible coste del LLM. Medir la llamada completa; la latencia anunciada de síntesis sólo cubre parte del turno. | Revalidar cancelación, memoria, tool calls y semántica de confirmación de extremo a extremo. Estimación de 1–2 semanas para una evaluación aislada. |

Las estimaciones son esfuerzo de ingeniería. Para comparar coste registrar minutos de sesión, tokens de entrada/salida/caché y caracteres sintetizados, calcular importe con la tarifa del día y dividir por minutos de conversación útil. Para privacidad registrar qué proveedor recibiría audio, texto, resultados de herramientas y metadatos. Como referencia al revisar el sprint, OpenAI lista para el audio de gpt-realtime-2.1 USD 32 por millón de tokens de entrada y USD 64 de salida. ElevenAgents publica USD 0,08 por minuto adicional estándar, sujeto al plan y costes del LLM. Un minuto conversacional incluye proporciones variables de habla y silencio. [OpenAI](https://platform.openai.com/pricing/) · [Modelos ElevenLabs](https://elevenlabs.io/docs/overview/models) · [SDK React Native](https://elevenlabs.io/docs/eleven-agents/libraries/react-native) · [Tarifas ElevenAgents](https://elevenlabs.io/pricing/agents)

## Prueba de escucha

Reservar medio día para preparar el guion y un día para escuchar y puntuar. Empezar con dos voces OpenAI admitidas por el modelo y la misma instrucción de estilo. Abrir una sesión nueva por voz, alternar el orden y ocultar el nombre al oyente. Usar los mismos auriculares y volumen. No utilizar contenido personal. Ejemplos:

- «¿Querés que prepare el borrador para mañana a las nueve y cuarto?»
- «Revisé el pull request del backend. El deploy sigue pendiente.»
- «Tengo el borrador listo. ¿Confirmás el envío a la dirección de prueba?»
- Interrumpir a mitad de la lectura de una fecha y volver a empezar la conversación tras desconectar.

Hacer diez turnos por voz y dispositivo, cinco interrupciones y diez nombres, horas o términos técnicos. Anotar naturalidad, comodidad, voseo y pronunciación en escala 1–5, inteligibilidad de cada dato, mediana/p95 de latencia y éxito de cada interrupción. Mantener la voz actual ante empate. Proponer el cambio si el usuario prefiere repetidamente la candidata, se conservan los detalles de confirmación y no empeora de forma apreciable la latencia o el barge-in respecto a la base. No se han producido ni evaluado muestras en este sprint.

Para una futura comparación basta una interfaz con iniciar, interrumpir, finalizar y observar estado. `VoiceProvider` ya expresa las tres operaciones. Mantener ejecución, permisos y confirmación en Core. Se decidiría una abstracción de síntesis sólo tras demostrar una mejora en la escucha. La evaluación cabe en V0.7/V0.8 independientemente de la publicación personal.
