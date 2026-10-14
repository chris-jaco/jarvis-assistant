# ADR-0068 — Compatibilidad con Atlas Web

- Estado: Aceptada

Atlas Web seguirá funcionando durante V0.6. No se duplicarán backend, Tool Registry, integraciones ni políticas. `WebCoreTransport` y `WebRealtimeTokenProvider` conservan el flujo HTTP actual; los clientes futuros aportarán implementaciones del mismo límite.

Los cambios desktop deben pasar las regresiones web. La retirada del cliente web, si alguna vez ocurre, requerirá otra decisión explícita.
