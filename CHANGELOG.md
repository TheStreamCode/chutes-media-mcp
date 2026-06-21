# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-06-21

Initial release.

### Added
- **MCP server** (`chutes-media-mcp`, stdio) exposing three tools: `list_media_models`,
  `describe_media_model`, `generate_media`.
- **CLI** (`chutes-media`) mirroring the same operations, with JSON output on stdout.
- **describe → generate** workflow: live cord schemas are fetched and handed to the agent; payloads
  are validated against the schema before invoking (no GPU spend on invalid input).
- Four media kinds — **image, video, music, speech** — plus **image editing** via per-model edit
  cords (img2img / inpaint), with workspace file paths auto base64-encoded (including array fields
  like `image_b64s`).
- **Automatic cold-start retry** with backoff when a model returns `503 no-instances`.
- Blocking invocation with progress updates (MCP progress notifications / CLI stderr) and per-kind
  timeouts (image/speech 120s, video/music 600s; overridable via `timeout_ms`).
- Best-effort per-invocation cost reporting from response headers.
- Optional **Agent Skill** (`skill/chutes-media`) documenting the workflow for Claude-family agents.
- Function-signature schema unwrapping: cords that wrap a single model param (e.g. `input_args`)
  accept the flat model on the wire; the package unwraps automatically.

### Notes
- Authentication uses a single `Authorization` header; the key is sent **raw** by default
  (`CHUTES_AUTH_SCHEME=bearer` to use the `Bearer` prefix).
- No default models are hardcoded — the catalog changes, so models are always discovered via
  `list_media_models` / `describe_media_model`.
