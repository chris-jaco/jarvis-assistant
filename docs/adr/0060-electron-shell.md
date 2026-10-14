# ADR-0060 — Electron como shell desktop inicial

- Estado: Aceptada para V0.6.1
- Plataforma inicial: Windows 11

## Decisión

Usar Electron para el primer shell desktop. Reutiliza el frontend TypeScript, el backend Node y el runtime Chromium donde Atlas ya usa OpenAI Realtime, WebRTC, micrófono y reproducción.

## Consecuencias

Aceptamos mayor tamaño de distribución y consumo que Tauri 2 a cambio de reducir las variables del vertical slice. Electron Main supervisará el backend; el renderer no tendrá privilegios Node. Tauri se reconsiderará si el footprint pasa a ser prioritario, WebView2 demuestra compatibilidad real de audio/Realtime y existe una estrategia sostenible para el sidecar Node o la migración de backend.

Electron todavía no se incorpora en Hito 0.
