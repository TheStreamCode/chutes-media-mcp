# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Send `CHUTES_API_KEY` only to HTTPS `chutes.ai` / `*.chutes.ai` management and invocation URLs;
  custom and loopback management endpoints now receive no credential.
- Bound management JSON and HTTP error bodies with `CHUTES_MAX_ASSET_MB`, and replace remaining
  catalog-controlled trailing-delimiter regexes with linear scans.
- Refresh vulnerable transitive dependencies for URL parsing, IP classification, Hono middleware,
  and Nano ID generation.

### Fixed

- Bound the short-lived model description cache, reject non-directory output ancestors before a GPU
  invocation, and keep generated asset plus provenance filenames within filesystem limits.
- Share MCP input limits with the CLI so both frontends reject oversized model, query, cord, and
  output values consistently.

## [2.0.2] — 2026-08-01

Backward-compatible security hardening, MCP metadata, documentation, and repository hygiene. No
tool/CLI input or result fields changed, and no dependencies were added or updated.

### Security

- Redact query strings and fragments from network-error messages so signed asset URL credentials do
  not leak into MCP or CLI logs.
- Reject additional IPv4 and IPv6 special-purpose ranges as asset download targets, including
  documentation, ORCHID, site-local, and deprecated 6to4 addresses.

### Fixed

- Document the full `generate_media` result in the README and the bundled agent skill. Both still
  listed the pre-1.2.0 shape and omitted `schemaHash` and `provenancePath`, which the tool has
  returned since 1.2.0.

### Changed

- Publish explicit MCP output schemas and duplicate each JSON text result in `structuredContent` for
  clients that support typed tool results. Mark the two read-only tools explicitly non-destructive.
- Add `AGENTS.md`: a project-specific contributor/AI-agent guide covering the architecture, the real
  npm scripts, the security-critical code paths, the deliberately pinned dependencies (the coupled
  `overrides.esbuild` / `allowScripts` pair, `@types/node`, `zod`, `typescript`), the versioning and
  release procedure, and the protected-branch workflow.
- Ignore `*.tgz` and `.npmrc` in git, so a local `npm pack` tarball or a token-bearing registry
  config can no longer be committed by accident.

## [2.0.1] — 2026-08-01

### Security

- Replace two polynomial regular-expression operations on configuration and model identifiers with
  bounded linear scans, resolving the CodeQL findings raised after the 2.0.0 release.

## [2.0.0] — 2026-08-01

This major release turns filesystem and network safeguards into enforced boundaries. Existing
automations that replace a named output must now opt in with `overwrite` / `--overwrite`.

### Security

- Restrict credential-bearing invocation requests to HTTPS Chutes hosts and reject redirects.
- Reject private/local asset downloads, unsafe redirects, and external hosts resolving to private
  network addresses.
- Enforce real-path workspace containment for input files and output directories; require explicit
  permission before overwriting an existing asset.
- Bound remote responses and local input assets to a configurable in-memory size limit.

### Changed

- Add ESLint, Prettier, coverage thresholds, CodeQL, a Node.js 24 CI job, pinned GitHub Actions, and
  a consolidated `npm run check` quality gate.
- Update the MCP SDK and development dependencies; override the vulnerable Hono adapter version.
- Add MCP tool safety annotations and stricter CLI/MCP argument validation.
- Exclude the repository-only logo from the npm tarball, reducing install size without affecting the
  runtime or bundled skill.

## [1.2.2] — 2026-07-25

### Security

- **Credential leak to lookalike domains.** `isChutesHost` matched the asset URL with a bare
  `hostname.endsWith("chutes.ai")`, so hosts such as `evilchutes.ai` satisfied it and the
  `Authorization` header — carrying `CHUTES_API_KEY` — was attached to the download. The asset URL
  comes from the invoked chute's own response and the server lists public chutes by design, so any
  third-party chute could harvest the key by returning a crafted URL. The check now requires the
  apex host or a real subdomain.
- **Arbitrary file read and upload.** `maybeEncodeFile` resolved every non-text string param against
  the workspace with no containment, so an absolute path or a `../` escape (`/etc/passwd`,
  `../../.ssh/id_rsa`) was read, base64-encoded and sent to the third-party model. Params come
  straight from the model, so the value was not user-controlled. Resolved paths are now required to
  stay inside the workspace root.
- Both fixes are covered by regression tests in `test/credential-scope.test.ts`.

### Fixed

- The server announced version `1.2.0` in the MCP handshake while the package shipped as `1.2.1`.
  The version is now read from `package.json` instead of being duplicated as a literal.

## [1.2.1] — 2026-07-10

### Security

- Added a root `overrides` entry pinning transitive `esbuild` to `0.28.1` to resolve the
  `GHSA-g7r4-m6w7-qqqr` advisory (arbitrary file read in the dev server on Windows, affecting
  `esbuild >=0.27.3 <0.28.1`). tsup 8.5.1 declares `esbuild ^0.27.0` so npm cannot auto-fix;
  the override is narrow (esbuild only) and will be removed once tsup publishes a release that
  depends on a non-vulnerable esbuild range.

### Changed

- Removed the internal `chutes-media-mcp-project-plan.md` planning document from the public repository; it was never part of the shipped package and only cluttered the source tree.

## [1.2.0] — 2026-06-21

### Added

- Per-run schema pinning + a `<asset>.json` provenance sidecar (model, cord, params, schema hash,
  cost, duration) written next to each asset for reproducibility. Disable with `CHUTES_PROVENANCE=false`.
- Strict params validation: fields not declared in the cord schema are rejected so a renamed/unknown
  field fails loudly instead of being silently dropped. Relax with `CHUTES_ALLOW_UNKNOWN_PARAMS=true`.
- Response guardrail: the returned media type is checked against the requested kind, so a 200 with the
  wrong content (not just a non-200) is caught.
- `generate_media` now returns `schemaHash` and `provenancePath`.

## [1.1.0] — 2026-06-21

### Added

- MCP server `instructions`: every client now receives the describe→generate workflow guidance on
  connect, so any coding agent knows how to use the tools without a separate skill.
- `chutes-media install-skill [--project]` — copies the bundled agent skill into the skills directory
  (`~/.claude/skills` by default, or `./.claude/skills` with `--project`).
- The agent skill is now shipped inside the published package.

## [1.0.0] — 2026-06-21

First stable release. Documentation and packaging polish; the public API and runtime behavior are
unchanged from 0.1.0.

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
- Optional **Agent Skill** (`skill/chutes-media`) documenting the describe→generate workflow
  (auto-loaded by Claude Code; usable as reference by any agent).
- Function-signature schema unwrapping: cords that wrap a single model param (e.g. `input_args`)
  accept the flat model on the wire; the package unwraps automatically.

### Notes

- Authentication uses a single `Authorization` header; the key is sent **raw** by default
  (`CHUTES_AUTH_SCHEME=bearer` to use the `Bearer` prefix).
- No default models are hardcoded — the catalog changes, so models are always discovered via
  `list_media_models` / `describe_media_model`.

[Unreleased]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v1.2.2...v2.0.0
[1.2.2]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TheStreamCode/chutes-media-mcp/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/TheStreamCode/chutes-media-mcp/releases/tag/v0.1.0
