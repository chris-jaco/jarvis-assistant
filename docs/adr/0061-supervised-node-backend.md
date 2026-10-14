# ADR-0061 — Backend Node supervisado

- Estado: Aceptada; implementación diferida a V0.6.1 Hito 1

Electron Main será propietario de un único proceso hijo Atlas Core. Lo iniciará, esperará readiness, observará health y realizará shutdown cooperativo con un plazo acotado. Sólo podrá terminar el PID hijo que creó; nunca buscará ni matará procesos Node ajenos.

Una segunda instancia enfocará la existente. Un crash del backend debe llevar la UI a un estado explícito y exigir una sesión nueva antes de restaurar herramientas. La recuperación no restaura confirmaciones, grants ni ejecuciones inciertas. Hito 0 no implementa supervisor, single-instance ni restart.
