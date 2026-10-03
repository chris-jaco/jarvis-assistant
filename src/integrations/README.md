# Integrations — V0.2

Implemented integrations: OpenAI hosted web search and Google Calendar API/OAuth.
Their backend adapters live in src/tools/adapters and are composed in
src/server/tools.ts. MCP support is an allowlisted official SDK server abstraction;
no remote MCP server is enabled by default.

Future Clockify, Notion, Onabox and Home Assistant examples in the root README
are extension guidance only; those integrations are not implemented.
