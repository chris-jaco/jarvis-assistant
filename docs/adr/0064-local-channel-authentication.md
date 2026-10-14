# ADR-0064 — Autenticación del canal local

- Estado: Implementada para el vertical slice; hardening y aceptación Windows pendientes

Escuchar en `127.0.0.1` no autentica al cliente. El transporte desktop tendrá una credencial aleatoria por lanzamiento, rotada al reiniciar, invalidada al cerrar y ausente de URLs, logs y almacenamiento web. Protegerá tools y `/api/realtime/token`.

La credencial se transferirá por un canal de bootstrap controlado por Main y se mediará mediante preload/IPC o un mecanismo equivalente. Entregar un token al renderer no protege contra un renderer comprometido: la superficie expuesta debe ser mínima, las operaciones sensibles siguen requiriendo autoridad backend y las decisiones nunca se derivan de datos del renderer.

Hito 1 usa HTTP loopback autenticado y mediación IPC semántica: Main posee la credencial y la cookie de sesión; el renderer no recibe una credencial reutilizable ni una API de HTTP/URL arbitraria. Un renderer comprometido aún puede pedir operaciones allowlisted, por lo que Core conserva schemas, permisos, confirmaciones e idempotencia como autoridad final.
