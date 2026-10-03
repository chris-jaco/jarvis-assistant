# Universal Tool Foundation — V0.2

Implemented in registry.ts, types.ts, permissions.ts, execution.ts and telemetry.ts.
Adapters live in adapters/. All privileged execution goes through ToolExecutor;
never expose adapter handlers directly to the browser or bypass confirmation.

See the root README for registration, REST/MCP extension instructions, security,
Google OAuth, timezone handling and manual acceptance tests.
