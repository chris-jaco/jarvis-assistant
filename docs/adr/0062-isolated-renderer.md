# ADR-0062 — Renderer aislado

- Estado: Aceptada; obligatoria antes del vertical slice Electron

El renderer usará `nodeIntegration: false`, `contextIsolation: true` y `sandbox: true`. El preload será mínimo, tipado y allowlisted. No se expondrán filesystem, procesos, shell genérico, secretos ni IPC arbitrario.

La aplicación tendrá CSP restrictiva, bloqueará navegación y ventanas no autorizadas y abrirá destinos externos mediante una operación explícita de Main. Los secretos permanecen en Main/Core. Un renderer comprometido sigue pudiendo actuar con las capacidades expresamente expuestas, por lo que el preload no será autoridad de confirmación ni recibirá credenciales duraderas.

Hito 0 no crea renderer ni preload.
