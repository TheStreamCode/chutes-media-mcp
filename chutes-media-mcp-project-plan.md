# Chutes Media MCP — Project Plan

> A standalone **MCP server** (plus a thin **CLI** and an optional **Skill**) that lets *any*
> coding agent — Claude Code, Cursor, Cline, Windsurf, Codex, OpenCode, Claude Desktop — generate
> **image, video, music, and speech** through **Chutes** during its normal workflow, saving the
> generated asset into the project the agent is working in.
>
> This is the MCP-first track. The "Chutes Zen" desktop fork is paused; if/when it resumes, it will
> simply connect to this MCP server instead of re-implementing media generation.

---

## 0. Agent orientation (read first)

You are building a **new, small** TypeScript package from scratch (not a fork). The design is:
one shared **core** with all Chutes logic, exposed through **two thin frontends** (an MCP server
over stdio, and a CLI), plus an **optional Skill** that documents the workflow (auto-loaded by Claude
Code; usable as reference by any agent).

```
chutes-media-mcp/
├── src/
│   ├── core/                 # all the real logic, no transport assumptions
│   │   ├── chutes-client.ts   # auth, list, describe, warmup, invoke, poll, download
│   │   ├── media-engine.ts    # describe→call orchestration, sync vs async, save, cost
│   │   ├── schema-validate.ts # light validation of agent-composed params vs model schema
│   │   ├── config.ts          # env/config resolution (key, base URLs, default models, output dir)
│   │   └── types.ts
│   ├── mcp/
│   │   └── server.ts          # MCP stdio server: registers the tools, delegates to core
│   ├── cli/
│   │   └── index.ts           # `chutes-media` CLI: same tools as subcommands
│   └── index.ts
├── skill/                     # optional: SKILL.md + skill.json documenting the workflow
├── package.json               # bins: chutes-media-mcp (server), chutes-media (cli)
├── README.md
├── LICENSE                    # MIT
└── .gitignore                 # blocks .env, keys, generated media
```

**Golden rule:** the core never knows whether it's called from MCP or CLI. Frontends are ~50-line
adapters. This is what makes the same logic reusable everywhere (and reusable by the desktop fork
later).

---

## 1. Goal & scope

### In scope
- An MCP server exposing media generation as agent tools, transport: **stdio** (the universal MCP
  transport every client supports).
- Four media kinds: **image (text-to-image, plus editing — img2img/inpaint — *when the chosen model
  exposes it*), video, music, speech**. (No 3D.) Image editing is not a separate kind or tool, and
  it is **not a platform-wide guarantee**: Chutes has no global edit endpoint. Editing exists only
  when an individual diffusion model publishes an edit cord (e.g. `/img2img`, `/inpaint`) on its own
  subdomain. The server discovers this per model at runtime and enables editing **only if** the cord
  exists; otherwise the `image` kind offers generation only. See §2 and `generate_media` in §3.
- The **describe → call** pattern: the agent fetches a model's real input schema, composes the
  payload, and submits it. The server owns all plumbing: auth, cold-start warmup, sync-vs-async
  handling, polling, download, saving to the workspace, light validation, and cost tracking.
- A thin **CLI** mirroring the tools, so even agents without MCP support can call it via bash.
- An optional **Skill** documenting when/how to use the tools (auto-loaded by Claude Code).
- Distribution via **npm**, runnable with `npx chutes-media-mcp`.

### Out of scope
- The Chutes Zen desktop fork (separate, paused track).
- 3D generation.
- A GUI. This is a headless tool for agents.
- Reimplementing LLM/chat — Chutes' OpenAI-compatible LLM endpoint is already usable directly by
  every client; this project is media only.

---

## 2. Chutes API facts (verified — build against these)

- **Auth:** single header `Authorization: Bearer <CHUTES_API_KEY>`. (Ignore the `X-Chutes-Hotkey`/
  `Signature`/`Nonce` headers — those are for Bittensor miners, not API-key consumers.)
- **Model discovery + schemas:** `GET /chutes/` supports `include_schemas` and pagination/filters
  (`name`, `slug`, `image`, `limit`, `offset`); `GET /chutes/{chute_id_or_name}` returns a single
  chute including its cord(s) and I/O schema. This powers `list_media_models` and
  `describe_media_model`.
- **Cold start:** `GET /chutes/warmup/{chute_id_or_name}?quick=true` returns immediately after a
  single status check — call before invoking a cold model.
- **Invocation:** each chute exposes a per-chute subdomain cord, e.g.
  `https://{username}-{slug}.chutes.ai/{public_api_path}` (often `/generate`), using the cord's
  declared method + input/output schema. Detect the cord/endpoint from the chute definition; do not
  hardcode paths.
- **Sync vs async:** image and speech are typically synchronous (response carries bytes/URL); video
  and music are long-running → submit, then poll until a result URL/bytes are ready. Determine the
  transport from the chute/cord metadata where possible, with a per-kind default as fallback.
- **Pricing/cost:** the Pricing endpoints expose per-model cost; capture per-invocation usage so the
  tool can report what each generation cost.

> Never hardcode a model's payload fields. Models differ (FLUX vs Wan2.1 vs DiffRhythm). The schema
> is fetched live and handed to the agent.

- **Image editing (img2img / inpaint) is per-model and conditional:** there is **no dedicated,
  platform-wide edit endpoint**. Each capability is exposed as a separate **cord on the individual
  model's subdomain** (a diffusion model might publish `/generate` plus, optionally, `/img2img`
  and/or `/inpaint`). So editing is available only for models that currently ship an edit cord, and
  the set of such models changes as the catalog changes (at times there may be none). The server
  must **discover the available cords per model at runtime** (from the chute definition / its
  schema) and route to the matching one; edit input fields (commonly `image`, `mask`,
  `strength`/`denoise`) live in that cord's schema. The agent discovers them via
  `describe_media_model` and fills them; the core resolves any workspace file path into the encoding
  the schema expects (base64 or multipart). When no edit cord exists, the `image` kind exposes
  generation only — never advertise an editing capability that the live model doesn't have. **Do
  not** confuse any of this with the REST `GET/POST /images/` section of the API reference — that
  section manages *deployment container images*
  (Docker build images for chutes), not picture generation, and is irrelevant to this project.

---

## 3. MCP tools (the contract the agent sees)

Keep the tool surface small and self-describing. Tool descriptions must tell the agent to **call
`describe_media_model` before `generate_media`** for any unfamiliar model.

### `list_media_models`
List available Chutes media models, optionally filtered by kind.
- **Input:** `{ kind?: "image" | "video" | "music" | "speech", query?: string, limit?: number }`
- **Behavior:** `GET /chutes/?include_schemas=false` + filter by kind/tagline; return
  `[{ name, kind, tagline, sync|async, approx_cost? }]`.

### `describe_media_model`
Fetch a model's real input schema so the agent can compose a valid request.
- **Input:** `{ model: string }`
- **Behavior:** `GET /chutes/{model}` (include schema). Return **all of the model's available cords**
  (e.g. `generate`, and `img2img`/`inpaint` if present) and, for each, its input JSON schema,
  required fields, types, defaults/ranges, and a minimal example payload — so the agent can see which
  operations (generate vs edit) the model actually supports. Cache per process for a short TTL.

### `generate_media`
Run a generation and save the result into the workspace.
- **Input:**
  `{ model: string, kind: "image"|"video"|"music"|"speech", params: object, output_dir?: string, filename?: string }`
  where `params` is the payload the agent composed from the described schema. For image editing,
  `params` may reference workspace file paths (e.g. `image`, `mask`) which the server resolves and
  encodes before sending.
- **Behavior (all in the server, not the agent):**
  1. Light-validate `params` against the described schema; on mismatch return a structured error
     listing what to fix (do **not** spend a GPU call on an invalid payload).
  2. **Resolve input assets:** if `params` references a workspace file (e.g. an `image`/`mask` path
     for img2img or inpaint), read it and encode it as the schema requires (base64 or multipart)
     before sending. This is what enables editing an image the agent generated moments earlier.
  3. `warmup?quick=true`.
  4. POST to the chute cord endpoint.
  5. **Sync** (image/speech): read result bytes/URL directly. **Async** (video/music): poll at the
     configured interval, emitting MCP progress notifications, until done or timeout.
  6. Download the asset; save under `output_dir` (default: `./chutes-media/` relative to the agent's
     CWD) with a sensible name; return `{ path, kind, model, bytes, cost?, durationMs }`.
- **Notes:** support a per-call timeout; surface cold-start/queue status via progress; on failure
  return a structured, actionable error.

### (optional, v1.1) `get_generation_status`
For very long video jobs, allow non-blocking submit + later poll. Defer unless needed; v1 keeps
`generate_media` blocking with internal polling + progress notifications.

---

## 4. Work breakdown

### Phase 1 — Scaffold + Chutes client core
- Init TS package (strict tsconfig, `tsup`/`tsx` build, vitest). MIT license. `.gitignore` blocking
  `.env`, keys, and `chutes-media/` output.
- `config.ts`: resolve `CHUTES_API_KEY` (env, required), base URLs, default models per kind,
  default output dir. **Never** read/write the key to the repo.
- `chutes-client.ts`: typed wrappers for `list`, `get/describe`, `warmup`, raw cord `invoke`,
  `download`. Bearer auth. Robust error normalization (401/404/422/429/5xx + cold-start).
- **Done when:** unit tests (mocked HTTP) cover auth, describe, warmup, and error mapping.

### Phase 2 — Media engine (describe → call, sync + async, save, cost)
- `schema-validate.ts`: validate composed `params` against a fetched JSON schema (required/type
  checks; clear error messages).
- `media-engine.ts`: orchestrate validate → resolve input assets → warmup → invoke → (sync read |
  async poll) → download → save → return result + cost. Detect transport from chute metadata with
  per-kind fallback. Emit progress via an injected callback (so MCP and CLI can both render it).
  Input-asset resolution reads workspace files referenced in `params` (img2img/inpaint) and encodes
  them per schema.
- Cost/usage capture per invocation.
- **Done when:** an integration test (live key, behind an env flag) generates one image (sync) and
  one short video (async), saving both and returning a cost figure. If an edit-capable image model is
  live in the catalog, the test also exercises editing that saved image via its `img2img`/`inpaint`
  cord; if none is available, the test asserts the `image` kind correctly exposes generation only.

### Phase 3 — MCP server frontend
- `mcp/server.ts`: stdio MCP server using the official MCP TypeScript SDK. Register the three tools;
  map MCP progress notifications to the engine's progress callback. Each handler is a thin delegate
  to the core.
- Bin entry `chutes-media-mcp`.
- **Done when:** the server runs under `npx`, is discoverable by an MCP client, and a coding agent
  completes a describe → generate → "embed the saved image in index.html" loop end to end.

### Phase 4 — CLI frontend (universal fallback)
- `cli/index.ts`: subcommands `list`, `describe <model>`, `generate --kind <k> --model <m> --params
  <json|file> [--output <dir>]`. Pretty progress to stderr; machine-readable JSON result to stdout
  (so agents can parse it).
- Bin entry `chutes-media`.
- **Done when:** every MCP tool has a CLI equivalent producing parseable output.

### Phase 5 — Optional Skill
- `skill/`: a `SKILL.md` (+ `skill.json`) teaching the describe → call workflow, default model
  choices per kind, payload composition tips, and the "save into the project, then reference it"
  pattern. This makes skill-aware agents more reliable; other agents just use the tools.
- **Done when:** with the Skill loaded, an agent picks the right kind and composes valid payloads
  across several models without hand-holding.

### Phase 6 — Package, publish, document
- README: install, configure (`CHUTES_API_KEY`), MCP client config snippet (stdio), CLI usage, a
  "generate media in your coding workflow" example, default models, and a cost note.
- MIT `LICENSE`; non-affiliation disclaimer
  (*"not officially affiliated with or endorsed by Chutes"*).
- Final secrets audit: no committed keys, examples use placeholders. Publish to npm.
- **Done when:** `npx chutes-media-mcp` works from a clean machine given only `CHUTES_API_KEY`, and
  the CLI/MCP both generate media.

---

## 5. Guardrails
- The core is transport-agnostic; MCP and CLI are thin adapters. No Chutes logic in the frontends.
- Never hardcode per-model payloads — always fetch and hand the live schema to the agent.
- Validate before spending a GPU call.
- `CHUTES_API_KEY` only from env/secure config, never committed; treat any real key in a diff as a
  blocking error.
- Default output dir is relative to the agent's CWD so generated assets land inside the project the
  agent is working on.
- Keep tool descriptions explicit that `describe_media_model` precedes `generate_media`.

## 6. Open decisions to confirm (Mikesoft)
- Default model per kind: image, video, music, speech.
- Default output directory name/layout (e.g. `./chutes-media/<kind>/`).
- v1 blocking `generate_media` vs adding non-blocking `get_generation_status` for long videos.
- Whether to ship the Skill in v1 or as a follow-up.

## 7. Why this order pays off
You can use the MCP server **today** inside Claude Code / Cursor / Codex while building client
sites — generate a hero image and have the agent drop it straight into the project, without
switching tools. And when the Chutes Zen desktop fork resumes, its hardest phase (media generation)
collapses into "connect to this MCP server."
