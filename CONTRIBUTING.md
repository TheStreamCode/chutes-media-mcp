# Contributing to chutes-media-mcp

Thanks for your interest in improving this project! Contributions of all kinds are welcome — bug
reports, fixes, new media-kind handling, docs, and tests.

## Architecture in one minute

The codebase is a shared **core** behind two thin frontends:

```
src/
├── core/
│   ├── chutes-client.ts   # HTTP: list, describe, warmup, invoke (cord), download; auth; error mapping
│   ├── media-engine.ts    # validate → resolve assets → warmup → invoke (blocking + retry) → save → cost
│   ├── schema-validate.ts # ajv validation of params against the live cord JSON Schema
│   ├── present.ts         # shared formatting of describe/list/errors (reused by MCP + CLI)
│   ├── config.ts          # env/config resolution
│   └── types.ts
├── mcp/server.ts          # MCP stdio server (thin) — registers the 3 tools, delegates to core
├── cli/index.ts           # CLI (thin) — same operations via util.parseArgs
└── index.ts               # public exports of the core
```

**Golden rule:** the core never knows whether it's called from MCP or CLI. Keep transport-specific
code in `mcp/` and `cli/`; keep all Chutes logic in `core/`. Never hardcode per-model payloads —
always fetch and validate against the live schema.

## Development setup

Requires **Node.js ≥ 20**.

```bash
npm install
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest (HTTP mocked)
npm run build        # tsup → dist/
```

### Windows `#`-in-path caveat

Vitest is built on Vite, which cannot resolve modules when the project path contains a `#`
(`#github-projects`, etc.). `typecheck` and `build` are unaffected. To run the tests, use a junction
at a clean path:

```powershell
New-Item -ItemType Junction -Path "$HOME\chutes-mcp-dev" -Target (Get-Location)
Push-Location "$HOME\chutes-mcp-dev"; npx vitest run; Pop-Location
```

`vitest.config.ts` sets `preserveSymlinks` so Vite stays on the clean junction path.

## Tests

- **Unit tests** (`src/**/*.test.ts`) mock HTTP via an injectable `fetch`, so they run offline. Add
  tests for any new behavior.
- **Live integration tests** (`test/integration.test.ts`) are opt-in and spend real GPU credits:

  ```bash
  $env:CHUTES_API_KEY = "cpk_..."
  $env:CHUTES_RUN_LIVE = "1"
  $env:CHUTES_LIVE_IMAGE_MODEL = "owner/image-model-slug"   # required for the image test
  $env:CHUTES_LIVE_VIDEO_MODEL = "owner/video-model-slug"   # optional
  npx vitest run test/integration.test.ts
  ```

## Coding conventions

- TypeScript strict, ESM, `node:` imports, explicit `.js` extensions in relative imports.
- Prefer native APIs (global `fetch`, `node:util` `parseArgs`) over new dependencies.
- Keep frontends thin; put logic in the core.
- Match the existing style; run `npm run typecheck` before opening a PR.

## Submitting changes

1. Fork and create a feature branch.
2. Make the change with accompanying tests; ensure `typecheck`, `test`, and `build` pass.
3. Open a pull request describing the change and how you verified it.

## Reporting bugs

Open an issue with: what you ran (tool/CLI + params, with secrets redacted), the expected vs actual
result, and any error output. For API-shape surprises, include the relevant `describe_media_model`
output (redacted).

## Security

Do not include real API keys in issues, PRs, or tests. See [SECURITY.md](./SECURITY.md).
