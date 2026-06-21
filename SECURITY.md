# Security Policy

## How the API key is handled

`chutes-media-mcp` treats your Chutes API key as an opaque secret, held only in memory:

- It is read **only** from the `CHUTES_API_KEY` environment variable; it is never written to disk by
  this tool.
- It is sent only in the `Authorization` header to the Chutes API and to a model's own
  `*.chutes.ai` subdomain. When a result references an external (non-`chutes.ai`) asset URL, the key
  is **not** attached to that download.
- It is never logged. The MCP server writes logs to stderr only; stdout carries the JSON-RPC channel.
- `.gitignore` blocks `.env`, `*.key`, and `*.pem`, and the published npm package contains only
  `dist/` (no sources, tests, or env files).

### Your responsibilities

- Never commit your key. Provide it via the environment or your MCP client's `env` config.
- Never paste a real key into issues, pull requests, logs, or test fixtures — use placeholders like
  `cpk_...`.
- Rotate the key if it is ever exposed.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Use GitHub's
**"Report a vulnerability"** (Security Advisories) on the repository, or contact the maintainer
listed in `package.json`.

Include: a description, reproduction steps, affected version, and impact. You'll receive an
acknowledgement, and fixes for confirmed issues will be released as promptly as possible with credit
if desired.
