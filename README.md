# Chutes Media MCP

Generate image, video, music, and speech through Chutes from any coding agent, with the asset saved
straight into the project you are working on.

[![CI](https://github.com/TheStreamCode/chutes-media-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TheStreamCode/chutes-media-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/chutes-media-mcp.svg)](https://www.npmjs.com/package/chutes-media-mcp)

![Chutes Media MCP at work: an MCP client, the model's live schema, and media saved into the workspace](https://raw.githubusercontent.com/TheStreamCode/chutes-media-mcp/main/assets/chutes-media-mcp.png)

Chutes Media MCP is a Model Context Protocol (MCP) server and command-line interface (CLI) that give
coding agents access to Chutes media models. It ships as an MCP server on standard input/output
(stdio), a thin CLI for agents without MCP support, and a bundled Agent Skill for the describe-then-generate
workflow.

Instead of hardcoding a payload per model, the server fetches the model's live schema and validates
each request before spending a GPU call, then writes the asset and a provenance record into your
workspace. It works with Claude Code, Cursor, Cline, Windsurf, Codex, OpenCode, and Claude Desktop.

This is an independent community project. It is not affiliated with, sponsored by, or endorsed by
Chutes.

## Install

Run the server from npm without installing it globally:

```bash
npx -y chutes-media-mcp
```

Install it globally to put both binaries on your path:

```bash
npm install -g chutes-media-mcp
```

Register the server with Claude Code:

```bash
claude mcp add chutes-media --env CHUTES_API_KEY=cpk_your_key -- npx -y chutes-media-mcp
```

For Cursor, Cline, Windsurf, OpenCode, and Claude Desktop, add the `mcpServers` entry documented in
[`docs/mcp-and-cli.md`](docs/mcp-and-cli.md). Running from GitHub instead of npm is supported with
`npx -y github:TheStreamCode/chutes-media-mcp`. Upgrading from 1.x? See
[`docs/migration-2.0.md`](docs/migration-2.0.md).

## Quick start

1. Create a Chutes API key at [chutes.ai](https://chutes.ai) and register the server as shown under
   Install.
2. Ask your agent for an asset: "Generate a cinematic hero image of a misty mountain range and save
   it in this project."
3. The agent discovers a suitable model, reads its live schema, validates the payload, and saves the
   result under `assets/chutes/image/`. The returned path is ready to reference from your code.

The same describe-then-generate flow is available from a shell through the `chutes-media` CLI. See
[`docs/mcp-and-cli.md`](docs/mcp-and-cli.md) for the tool reference, CLI examples, and image editing.

## Features

- Four media kinds (image, video, music, speech), plus image editing when a model exposes an edit
  cord such as `img2img` or `inpaint`.
- Live model contract: cords and input schema are fetched at runtime, never hardcoded.
- Payload validation against the live schema before any GPU call is made.
- Workspace-contained file access; existing assets survive unless `overwrite` is explicitly set.
- A provenance sidecar per asset with model, cord, params, and schema hash.
- Automatic cold-start retry with backoff for models that scale to zero.
- Progress updates for long video and music jobs.
- One shared core, so the MCP server and the CLI behave identically.

## Requirements

- Node.js 20.3 or newer for the published server and CLI. Node.js 20 is end-of-life; use Node.js 22
  or 24 LTS in production.
- A Chutes API key.
- Contributors using the locked toolchain need Node.js ^20.19.0, >= 22.13.0, or >= 24.

## Configuration

| Variable                       | Required | Default                 | Purpose                                                                                                                                              |
| ------------------------------ | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHUTES_API_KEY`               | Yes      | none                    | Chutes API key. Read from the environment; never written to disk.                                                                                    |
| `CHUTES_AUTH_SCHEME`           | No       | `raw`                   | How the key is sent in `Authorization`: `raw` (the key as-is) or `bearer` (value prefixed with `Bearer` and a space). On a 401, try the other value. |
| `CHUTES_API_BASE_URL`          | No       | `https://api.chutes.ai` | Management API base URL. HTTPS is required except for loopback development; custom endpoints never receive the Chutes API key.                       |
| `CHUTES_OUTPUT_DIR`            | No       | `assets/chutes`         | Output directory inside the agent's working directory. A `<kind>/` subfolder is appended.                                                            |
| `CHUTES_WARMUP`                | No       | `true`                  | Warm models up before invoking them. Set to `false` to skip warmup.                                                                                  |
| `CHUTES_COLD_START_RETRIES`    | No       | `4`                     | Retries when a cold model returns `503 no-instances`. `0` disables retries.                                                                          |
| `CHUTES_COLD_START_BACKOFF_MS` | No       | `8000`                  | Base backoff between cold-start retries; it grows per attempt.                                                                                       |
| `CHUTES_MAX_ASSET_MB`          | No       | `512`                   | Maximum response or local input asset size kept in memory. The maximum is `4096`.                                                                    |
| `CHUTES_PROGRESS_INTERVAL_MS`  | No       | `5000`                  | How often progress heartbeats are emitted while a call blocks.                                                                                       |
| `CHUTES_ALLOW_UNKNOWN_PARAMS`  | No       | `false`                 | When `true`, accept parameters that are not in the model schema. The default rejects them so a renamed field fails loudly.                           |
| `CHUTES_PROVENANCE`            | No       | `true`                  | Write a `<asset>.json` sidecar with model, cord, params, and schema hash. Set to `false` to disable.                                                 |

Generated assets are saved under `./assets/chutes/<kind>/`, relative to wherever the agent runs, so
they land inside the project. Output traversal and symlink escapes are rejected, and existing files
are preserved unless overwrite is enabled.

## Privacy and security

The API key is read from `CHUTES_API_KEY` and kept in memory. Credential-bearing requests go only to
HTTPS Chutes hosts, remote asset URLs are screened against private-network destinations, and file
access is contained to the workspace. Query strings and fragments are removed from network-error
messages so signed asset URLs do not end up in logs. The project collects no telemetry. See
[`SECURITY.md`](SECURITY.md) for reporting.

## Troubleshooting

### A Chutes request returns 401

The key is missing, invalid, or sent with the wrong authentication scheme. Confirm `CHUTES_API_KEY`
is set for the process that launches the server, then set `CHUTES_AUTH_SCHEME` to `bearer` or `raw`,
whichever differs from the current value.

### A model returns 503 no-instances

The model is scaled to zero and Chutes has no instance ready. The server retries automatically;
raise `CHUTES_COLD_START_RETRIES` and `CHUTES_COLD_START_BACKOFF_MS` if the delay is too short, or
pick another model of the same kind.

### Generation fails with an unknown or rejected parameter

The live model schema changed or the parameter name is wrong. Call `describe_media_model` again and
rebuild the payload from the current schema. `CHUTES_ALLOW_UNKNOWN_PARAMS=true` is a temporary
workaround, not a fix.

### An asset write is rejected

Every input and output path must resolve inside the current workspace, and an existing file is not
replaced implicitly. Pass the explicit `overwrite` option (or `--overwrite` in the CLI) after
checking the target path.

## Development

Requirements: Node.js ^20.19.0, >= 22.13.0, or >= 24 with npm.

```bash
git clone https://github.com/TheStreamCode/chutes-media-mcp
cd chutes-media-mcp
npm ci
npm run check
npm run verify:mcp
npm run release:check
```

`npm run check` runs the format check, lint, type check, coverage tests, and the build.
`npm run verify:mcp` starts the built stdio server with a placeholder key and validates the MCP
handshake, the instructions and the three tool definitions without calling Chutes. `npm run
release:check` keeps `package.json`, `CHANGELOG.md`, `CITATION.cff` and `server.json` on the same
version.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the Windows path caveat and the opt-in live tests.

## Support

Ask usage questions in [GitHub Discussions](https://github.com/TheStreamCode/chutes-media-mcp/discussions),
report reproducible defects in [GitHub Issues](https://github.com/TheStreamCode/chutes-media-mcp/issues),
and report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests must pass the required CI checks.

## License

MIT — see [`LICENSE`](LICENSE). Third-party notices are in [`NOTICE`](NOTICE).

---

Maintained by [Michael Gasperini (Mikesoft)](https://mikesoft.it).
If this project is useful to you, consider [sponsoring its maintenance](https://github.com/sponsors/TheStreamCode).
