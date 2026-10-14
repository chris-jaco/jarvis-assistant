# ADR-0069 — Wake word local

- Estado: Aceptada como dirección; fuera de Hito 0

La activación «Atlas» se procesará localmente. Push-to-talk seguirá disponible. La UI indicará inequívocamente cuándo el micrófono está activo y ofrecerá controles para desactivar wake word y captura.

La elección de motor dependerá de privacidad, falsos positivos, CPU/RAM, distribución y soporte Windows. No se enviará audio a servicios remotos antes de una activación autorizada. Hito 0 no selecciona motor ni captura en background.
