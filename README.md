# chutes-media-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/chutes-media-mcp.svg)](https://www.npmjs.com/package/chutes-media-mcp)
[![Sponsor](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/TheStreamCode)

Generate **image, video, music and speech** through [Chutes](https://chutes.ai) from inside any
coding agent — Claude Code, Cursor, Cline, Windsurf, Codex, OpenCode, Claude Desktop — and have the generated
asset saved straight into the project you're working on.

It ships as:

- an **MCP server** (`chutes-media-mcp`, stdio) — the primary, universal interface,
- a thin **CLI** (`chutes-media`) — a fallback for shells and agents without MCP support, and
- an optional **Agent Skill** ([`skill/chutes-media`](./skill/chutes-media)) documenting the
  describe→generate workflow (auto-loaded by Claude Code; usable as reference by any agent).

Both frontends are thin adapters over one shared, transport-agnostic core, so they behave
identically.

> **Not officially affiliated with or endorsed by Chutes.** "Chutes" belongs to its respective
> owners; this is an independent, open-source community tool.

---

## Features

- 🎨 Four media kinds: **image, video, music, speech** — plus **image editing** (img2img / inpaint)
  when a model exposes an edit cord.
- 🔎 **describe → generate** workflow: the live model schema is fetched and handed to the agent;
  payloads are never hardcoded.
- 💾 Saves assets into your project (default `./assets/chutes/<kind>/`) and returns the path.
- ✅ **Validates** the payload against the live schema before spending a GPU call.
- 🔁 **Automatic cold-start retry** with backoff for models scaled to zero.
- 📡 Progress updates during long video/music jobs (MCP progress notifications / CLI stderr).
- 🧩 Works everywhere: MCP server **or** CLI, same behavior.

## How it works: describe → generate

Chutes models differ wildly (FLUX vs Qwen-Image vs Wan vs LTX vs ACE-Step vs a TTS model), so
payloads are **never hardcoded**. The flow is always:

1. **`list_media_models`** — discover a model for the kind you want.
2. **`describe_media_model`** — fetch the model's live cords and input schema.
3. **`generate_media`** — submit the payload you composed; the asset is saved into the workspace.

The server owns all the plumbing: auth, cold-start warmup + retry, blocking invocation with progress,
downloading, saving, light validation, and best-effort cost reporting.

---

## Requirements

- **Node.js ≥ 20**
- A **Chutes API key** (`CHUTES_API_KEY`). Create one in your Chutes account.

## Install

An MCP server isn't "installed" like an app — it's registered as a **command** in your MCP client's
config (see [Use as an MCP server](#use-as-an-mcp-server)). Pick whichever way of providing that
command suits you:

**1. `npx` from npm — recommended (no install):**

```bash
npx chutes-media-mcp        # MCP server (stdio)
npx -p chutes-media-mcp chutes-media --help   # CLI bin
```

**2. Global install:**

```bash
npm install -g chutes-media-mcp
# then `chutes-media-mcp` (server) and `chutes-media` (CLI) are on your PATH
```

**3. Directly from GitHub (no npm needed):** builds on install via the `prepare` script.

```bash
npx -y github:TheStreamCode/chutes-media-mcp
```

**4. From source (for development):**

```bash
git clone https://github.com/TheStreamCode/chutes-media-mcp
cd chutes-media-mcp && npm install && npm run build
# then point your client at: node /abs/path/dist/mcp/server.js
```

> The package ships two bins: `chutes-media-mcp` (the MCP server) and `chutes-media` (the CLI).

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CHUTES_API_KEY` | ✅ | — | Your Chutes API key. Read from the environment; never written to disk. |
| `CHUTES_AUTH_SCHEME` | | `raw` | How the key is sent in `Authorization`: `raw` (the key as-is) or `bearer` (prefixed `Bearer `). On a 401, try flipping this. |
| `CHUTES_API_BASE_URL` | | `https://api.chutes.ai` | Management API base URL. |
| `CHUTES_OUTPUT_DIR` | | `assets/chutes` | Output directory (relative to the agent's CWD). A `<kind>/` subfolder is appended. |
| `CHUTES_WARMUP` | | `true` | Warm models up before invoking. Set `false` to skip. |
| `CHUTES_COLD_START_RETRIES` | | `4` | Retries when a cold model returns `503 no-instances` (`0` disables). |
| `CHUTES_COLD_START_BACKOFF_MS` | | `8000` | Base backoff between cold-start retries (grows per attempt). |
| `CHUTES_PROGRESS_INTERVAL_MS` | | `5000` | How often progress heartbeats are emitted while a call blocks. |

Generated assets are saved to `./assets/chutes/<kind>/` by default, relative to wherever the agent is
running — so they land inside the project being worked on.

---

## Use as an MCP server

**Claude Code:**

```bash
claude mcp add chutes-media --env CHUTES_API_KEY=cpk_your_key -- npx -y chutes-media-mcp
```

**Cursor / Cline / Windsurf / OpenCode / Claude Desktop** (generic `mcpServers` config):

```json
{
  "mcpServers": {
    "chutes-media": {
      "command": "npx",
      "args": ["-y", "chutes-media-mcp"],
      "env": { "CHUTES_API_KEY": "cpk_your_key" }
    }
  }
}
```

> To run without npm, replace the args with `["-y", "github:TheStreamCode/chutes-media-mcp"]`.

### Tools

- **`list_media_models`** — `{ kind?, query?, limit? }` → matching models.
- **`describe_media_model`** — `{ model }` → every cord with required fields, types, defaults, a
  minimal example payload, and a top-level `supportsEditing`. Call this before generating.
- **`generate_media`** — `{ model, kind, params, cord?, output_dir?, filename?, timeout_ms? }` →
  runs the generation and returns
  `{ path, kind, model, cord, bytes, contentType, cost?, durationMs }`. `params` is what you composed
  from the described schema.

### Example agent workflow

> "Generate a hero image of a misty mountain range and drop it into the landing page."

The agent calls `describe_media_model` on an image model, composes
`{ prompt: "misty mountain range at dawn, cinematic", width: 1024, height: 1024 }`, calls
`generate_media`, gets back `./assets/chutes/image/<model>-<timestamp>.png`, and references that path
in `index.html`.

---

## Use as a CLI

```bash
export CHUTES_API_KEY="cpk_your_key"          # PowerShell: $env:CHUTES_API_KEY = "cpk_..."

# Discover models
chutes-media list --kind image
chutes-media list --query flux

# Inspect a model's schema
chutes-media describe owner/model-slug

# Generate (inline JSON, @file, or a path to a .json file for --params)
chutes-media generate --kind image --model owner/model-slug \
  --params '{"prompt":"a red bicycle on a cobblestone street"}'
```

Progress is printed to **stderr**; the JSON result (including the saved `path`) is printed to
**stdout**, so agents can parse it.

---

## Image editing (img2img / inpaint)

Chutes has **no platform-wide edit endpoint**. Editing exists only when a model publishes an edit
cord (e.g. `img2img`, `inpaint`) or is a dedicated edit model. `describe_media_model` reports
`supportsEditing` and lists those cords. To use one, reference a workspace file in `params` (a single
field like `image`, or an array like `image_b64s`) — the server reads the file and base64-encodes it:

```bash
chutes-media generate --kind image --model owner/edit-capable --cord img2img \
  --params '{"prompt":"make it snowy","image":"assets/chutes/image/scene.jpg","strength":0.6}'
```

When a model has no edit cord, only generation is available.

---

## Agent Skill (optional)

[`skill/chutes-media`](./skill/chutes-media) is an Agent Skill documenting the describe→generate
discipline, payload composition, editing, and cold-start handling. Claude Code auto-loads it from your
skills directory; install it by copying the folder there:

```bash
cp -r skill/chutes-media ~/.claude/skills/chutes-media          # user-level
# or, per project:
cp -r skill/chutes-media .claude/skills/chutes-media
```

Agents without skill auto-loading don't need it — they just call the tools/CLI directly (and can read
the file as reference).

---

## Cost

Chutes prices by compute units. When a model exposes the cost via a response header it is returned as
`cost`; otherwise `cost` is omitted. Check the [Chutes pricing](https://chutes.ai) for per-model
rates.

> 💡 Many public models scale to zero and may return `503 no-instances` until they warm up. The
> server retries automatically; if a model stays cold, pick another of the same kind.

---

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the build/test commands, and the Windows `#`-path
caveat. Quick version:

```bash
npm install
npm run typecheck
npm run test
npm run build
```

## Security

Never commit your API key. See [SECURITY.md](./SECURITY.md) for how the key is handled and how to
report vulnerabilities.

## Author

Built by **[Michael Gasperini](https://mikesoft.it)** — founder of [Mikesoft](https://mikesoft.it),
building small, focused, privacy-aware developer tools.

If this project is useful to you, consider [sponsoring its development](https://github.com/sponsors/TheStreamCode). 💛

## License

[MIT](./LICENSE) © Michael Gasperini (Mikesoft)
