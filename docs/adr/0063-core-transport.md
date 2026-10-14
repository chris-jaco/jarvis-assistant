# ADR-0063 — CoreTransport

- Estado: Implementada en V0.6.1 Hito 0

## Decisión

El cliente depende de un contrato `CoreTransport` con un mapa cerrado de operaciones semánticas: sesión, actividad, invocación, confirmaciones, memoria y lifecycle/continuaciones Browser. El contrato no depende de DOM ni Electron y conserva los tipos existentes de tools, telemetría y continuación.

`WebCoreTransport` traduce esas operaciones a los endpoints `/api/tools/*` existentes, preservando métodos, JSON, cookies same-origin, timeout, cancelación, headers de correlación Browser y motivo de cierre. No reintenta solicitudes.

`VoiceToolBridge` y `VoiceMemoryBridge` reciben el transporte por inyección explícita. La implementación desktop futura podrá satisfacer el mismo contrato, pero deberá añadir autenticación y mantener orden, idempotencia y autoridad backend. `CoreTransport` no contiene lógica de herramientas ni concede permisos.
