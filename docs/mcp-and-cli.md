# MCP clients, tools, and CLI

The package exposes one shared core through two frontends: an MCP (Model Context Protocol) server on
standard input/output (stdio) and a CLI. Both follow the same describe-then-generate flow.

## Register the MCP server

Claude Code:

```bash
claude mcp add chutes-media --env CHUTES_API_KEY=cpk_your_key -- npx -y chutes-media-mcp
```

Cursor, Cline, Windsurf, OpenCode, and Claude Desktop use a generic `mcpServers` configuration:

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

To run without npm, replace the arguments with `["-y", "github:TheStreamCode/chutes-media-mcp"]`.

## Tools

- `list_media_models` — `{ kind?, query?, limit? }` returns the matching models.
- `describe_media_model` — `{ model }` returns every cord with required fields, types, defaults, a
  minimal example payload, and a top-level `supportsEditing`. Call this before generating.
- `generate_media` — `{ model, kind, params, cord?, output_dir?, filename?, timeout_ms?, overwrite? }`
  runs the generation and returns
  `{ path, kind, model, cord, bytes, contentType, cost?, durationMs, schemaHash?, provenancePath? }`.

`params` is what you compose from the described schema. `schemaHash` pins the exact cord schema the
payload was validated against. `provenancePath` points at the sidecar and is omitted when
`CHUTES_PROVENANCE=false`.

Each tool publishes an output schema and returns the same JSON object both as text and as MCP
`structuredContent`, so clients can consume typed results without parsing the text representation.

## Example agent workflow

The agent calls `describe_media_model` on an image model, composes
`{ prompt: "misty mountain range at dawn, cinematic", width: 1024, height: 1024 }`, calls
`generate_media`, and gets back `./assets/chutes/image/<model>-<timestamp>.png`, which it can
reference from the project.

## Use the CLI

```bash
export CHUTES_API_KEY="cpk_your_key"          # PowerShell: $env:CHUTES_API_KEY = "cpk_..."

# Discover models
chutes-media list --kind image
chutes-media list --query flux

# Inspect a model's schema
chutes-media describe owner/model-slug

# Generate from inline JSON, @file, or a path to a .json file for --params
chutes-media generate --kind image --model owner/model-slug \
  --params '{"prompt":"a red bicycle on a cobblestone street"}'

# Replacing an existing named asset must be explicit
chutes-media generate --kind image --model owner/model-slug --filename hero.jpg --overwrite \
  --params '{"prompt":"a red bicycle on a cobblestone street"}'
```

Progress is printed to stderr; the JSON result, including the saved `path`, is printed to stdout so
agents can parse it.

## Image editing

Chutes has no platform-wide edit endpoint. Editing exists only when a model publishes an edit cord
(such as `img2img` or `inpaint`) or is a dedicated edit model. `describe_media_model` reports
`supportsEditing` and lists those cords. Reference a workspace file in `params` (a single field such
as `image`, or an array such as `image_b64s`) and the server reads the file and base64-encodes it:

```bash
chutes-media generate --kind image --model owner/edit-capable --cord img2img \
  --params '{"prompt":"make it snowy","image":"assets/chutes/image/scene.jpg","strength":0.6}'
```

When a model has no edit cord, only generation is available.

## Install the optional Agent Skill

The MCP server already ships instructions for the describe-then-generate workflow, so any client
receives guidance on connect. Claude Code can additionally install the bundled Agent Skill
([`../skill/chutes-media`](../skill/chutes-media)):

```bash
npx -p chutes-media-mcp chutes-media install-skill             # -> ~/.claude/skills/chutes-media
npx -p chutes-media-mcp chutes-media install-skill --project   # -> ./.claude/skills/chutes-media
```

Agents without skill auto-loading do not need it.

## Cost

Chutes prices by compute units. When a model exposes its cost through a response header, the cost is
returned in the `cost` field; otherwise the field is omitted. Check the
[Chutes pricing](https://chutes.ai) page for per-model rates.
