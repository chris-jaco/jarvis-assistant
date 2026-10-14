# ADR-0067 — No restaurar autorizaciones operativas

- Estado: Aceptada

Tras reiniciar cliente, Core, Bridge o dispositivo no se restauran confirmaciones pendientes, grants operativos, capabilities de un uso ni approvals. Las ejecuciones reservadas/incompletas conservan `UNKNOWN` mediante el journal y nunca se reintentan automáticamente.

Memoria, credenciales OAuth y políticas persistentes de sitio mantienen sus reglas actuales, pero no constituyen autoridad para una acción. La reconexión crea una sesión operativa nueva.
