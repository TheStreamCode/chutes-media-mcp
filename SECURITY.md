# Security Policy

## Supported versions

Security fixes are applied to the latest published release. Please upgrade to the current npm
`latest` version before reporting an issue.

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| 1.x     | No        |

## How the API key is handled

`chutes-media-mcp` treats your Chutes API key as an opaque secret, held only in memory:

- It is read **only** from the `CHUTES_API_KEY` environment variable; it is never written to disk by
  this tool.
- It is sent only in the `Authorization` header to the Chutes API and to a model's own
  HTTPS `*.chutes.ai` subdomain. Invocation URLs supplied by the catalog are rejected if they point
  anywhere else. When a result references an external (non-`chutes.ai`) asset URL, the key is **not**
  attached to that download.
- It is never logged. The MCP server writes logs to stderr only; stdout carries the JSON-RPC channel.
- `.gitignore` blocks `.env`, `*.key`, and `*.pem`, and the published npm package excludes source,
  test, environment, and repository-maintenance files.

## File and network boundaries

- Input files are read only from the current workspace. Both lexical traversal and real-path
  escapes through symlinks or junctions are rejected before upload.
- Outputs are written only inside the current workspace. A `filename` must be a single portable file
  name, and replacing an existing asset requires an explicit `overwrite` option.
- Asset downloads require HTTPS. Explicit private/local addresses, DNS resolutions to non-public
  addresses, IPv4/IPv6 special-purpose ranges, credential-bearing URLs, and unsafe redirect
  destinations are rejected.
- Network-error messages retain the destination origin and path for troubleshooting but omit query
  strings and fragments, which commonly carry credentials in signed asset URLs.
- Remote responses and local input assets are subject to a configurable size limit before being
  retained in memory.
- These controls reduce accidental and model-driven data exposure; they do not make an untrusted
  third-party model safe. Review the model and provider before sending sensitive media or prompts.

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
