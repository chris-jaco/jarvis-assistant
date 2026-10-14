# ADR-0064 — Autenticación del canal local

- Estado: Aceptada; bloqueante para conectar Electron al backend

Escuchar en `127.0.0.1` no autentica al cliente. El transporte desktop tendrá una credencial aleatoria por lanzamiento, rotada al reiniciar, invalidada al cerrar y ausente de URLs, logs y almacenamiento web. Protegerá tools y `/api/realtime/token`.

La credencial se transferirá por un canal de bootstrap controlado por Main y se mediará mediante preload/IPC o un mecanismo equivalente. Entregar un token al renderer no protege contra un renderer comprometido: la superficie expuesta debe ser mínima, las operaciones sensibles siguen requiriendo autoridad backend y las decisiones nunca se derivan de datos del renderer.

Antes del Hito 1 se elegirá entre HTTP loopback autenticado o mediación IPC/pipe. Hito 0 no implementa autenticación desktop.
