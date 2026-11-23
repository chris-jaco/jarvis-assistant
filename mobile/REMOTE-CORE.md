# Contrato propuesto para un Core personal

Hoy el teléfono inicia una sesión de voz de desarrollo y las herramientas remotas están deshabilitadas. Para usar Gmail, Calendar y memoria con la PC apagada el ejecutor tendría que vivir en un Core personal disponible por TLS. El chat de voz es efímero. La memoria semántica tiene otro ciclo de vida. Decidir por separado qué historial conservar, quién puede leerlo, su plazo y el procedimiento de borrado.

| Mensaje | Campos reutilizables | Obligación adicional del Core remoto |
|---|---|---|
| Abrir sesión | Descriptores de herramientas, timezone y now de CoreSessionConfiguration | Verificar usuario, dispositivo registrado, sesión revocable y alcance antes de emitir la credencial Realtime corta. Vincular claves de dispositivo en Keystore. |
| Preparar herramienta | invocationId, toolId, input de CoreOperationMap | Validar schema y permiso, congelar cuenta/operación/contenido, retornar resumen, digest, expiración y nonce de un uso. |
| Responder a una confirmación | confirmationId y approved; el resumen se presenta íntegro | Obtener identidad del transporte autenticado. Rechazar operación editada, dispositivo ajeno, sesión revocada o decisión fuera de tiempo. Reservar en una transacción duradera antes del efecto. |
| Recuperar resultado | Estados pending, success y error de ToolResult | Idempotencia por usuario/dispositivo/operación, devolver estado previo. Marcar resultado incierto tras una caída sin prueba de efecto y exigir verificación humana. |
| Finalizar o perder dispositivo | Conceptos session.close y revocación | Invalidar refresh tokens y pendientes de ese dispositivo. Registrar sólo IDs, tiempo y estado. Android libera el micrófono de inmediato. |

El bridge de Chrome sigue en el PC autorizado y puede estar offline. Los adapters de Gmail y Calendar correrían una vez en Core. El móvil sólo recibe proyecciones autorizadas. La credencial aleatoria del loopback Desktop se queda en esa máquina. Antes de alojar tokens en remoto se necesitan almacenamiento cifrado, gestión de claves y pruebas de recuperación y borrado. Definir emparejamiento inicial y recuperación de un teléfono perdido antes del despliegue.

Los ejemplos ejecutables en `test/remote-contract.test.mjs` verifican las decisiones con dos dispositivos simulados. TLS, persistencia transaccional, identidad, criptografía y revocación distribuida requieren un diseño aprobado y validación aparte. No hay servidor remoto en este workspace.
