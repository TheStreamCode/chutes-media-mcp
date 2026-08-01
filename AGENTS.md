# AGENTS.md — working on `chutes-media-mcp`

Operating guide for AI coding agents and new contributors. It describes **this** repository only.
Read it before changing anything; the rules below encode decisions that were made deliberately and
that are easy to undo by accident.

## What this project is

`chutes-media-mcp` is a published npm package that lets a coding agent generate **image, video,
music and speech** through [Chutes](https://chutes.ai) and save the asset straight into the user's
project. It ships three surfaces from one codebase:

- an **MCP server** (`chutes-media-mcp` bin, stdio transport) — the primary interface,
- a thin **CLI** (`chutes-media` bin) — fallback for shells and agents without MCP,
- a bundled **Agent Skill** (`skill/chutes-media/`) documenting the describe→generate workflow.

Repository: <https://github.com/TheStreamCode/chutes-media-mcp> · **public**, MIT.
Registry: <https://www.npmjs.com/package/chutes-media-mcp>.

## Stack and runtime

- **TypeScript** (strict, ESM only), bundled with **tsup** (esbuild), `target: node20`.
- **Runtime for the published artifact: Node.js ≥ 20.3** (`engines.node`). Do not raise this without
  a major version bump — it is a breaking change for installed users.
- **Development toolchain** needs Node.js `^20.19.0`, `≥ 22.13.0`, or `≥ 24`. CI runs the matrix
  **20 / 22 / 24** on `ubuntu-latest`.
- **Package manager: npm, with `package-lock.json`.** Never introduce pnpm, yarn or bun, never add a
  second lockfile, and never hand-edit `package-lock.json` — change it only through npm commands.
- Runtime dependencies are deliberately minimal: `@modelcontextprotocol/sdk`, `ajv`, `zod`. Prefer
  native Node APIs (global `fetch`, `node:util` `parseArgs`, `node:crypto`) over new dependencies.

## Architecture

```
src/
├── core/                  # transport-agnostic; knows nothing about MCP or the CLI
│   ├── chutes-client.ts   # HTTP: list / describe / warmup / invoke / download, auth, URL safety, error mapping
│   ├── media-engine.ts    # validate → resolve input assets → warmup → invoke (retry) → save → provenance
│   ├── schema-validate.ts # Ajv validation of params against the live cord JSON Schema
│   ├── present.ts         # shared describe/list/error formatting, reused by both frontends
│   ├── config.ts          # environment → ChutesConfig
│   └── types.ts           # shared types
├── mcp/server.ts          # MCP stdio server — registers the 3 tools, delegates to core
├── cli/index.ts           # CLI — same operations via util.parseArgs
└── index.ts               # public exports of the core
```

**Golden rules**

1. The core never knows which frontend called it. Transport-specific code belongs in `mcp/` or
   `cli/`; all Chutes logic belongs in `core/`.
2. **Never hardcode a per-model payload.** Chutes models differ wildly, so the flow is always
   `list_media_models` → `describe_media_model` → `generate_media`, validating against the live
   schema fetched at runtime.
3. Both frontends must stay behaviourally identical. A change to one usually needs the other.
4. `stdout` is reserved for the MCP JSON-RPC channel and for the CLI's JSON result. **All logging
   goes to stderr** (`console.error`, `process.stderr.write`).

## Commands

All commands are npm scripts defined in `package.json`; do not invent others.

| Purpose          | Command                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| Install          | `npm ci` (also runs `prepare` → `build`)                                     |
| Watch build      | `npm run dev`                                                                |
| Format           | `npm run format` / check only: `npm run format:check`                        |
| Lint             | `npm run lint` (ESLint, `--max-warnings=0`)                                  |
| Type-check       | `npm run typecheck` (`tsc --noEmit`)                                         |
| Tests            | `npm test` · watch: `npm run test:watch` · coverage: `npm run test:coverage` |
| Build            | `npm run build` (tsup → `dist/`)                                             |
| **Full gate**    | `npm run check` (format:check + lint + typecheck + coverage + build)         |
| Packaging        | `npm pack --dry-run` (inspect) · `npm pack` (write the tarball)              |
| Dependency audit | `npm audit --omit=dev --audit-level=high` (the CI gate)                      |
| Publish          | `npm publish` — maintainer only; `prepublishOnly` runs `npm run check`       |

Coverage thresholds (enforced, `vitest.config.ts`): statements 80, branches 70, functions 80,
lines 80, measured over `src/core/**`.

### Windows `#`-in-path caveat

Vitest/Vite cannot resolve modules when the project path contains a `#`. `typecheck` and `build` are
unaffected. Run the tests through a junction at a clean path:

```powershell
New-Item -ItemType Junction -Path "$HOME\chutes-mcp-dev" -Target (Get-Location)
Push-Location "$HOME\chutes-mcp-dev"; npx vitest run; Pop-Location
```

`vitest.config.ts` sets `resolve.preserveSymlinks` so Vite stays on the clean path.

### Live integration tests

`test/integration.test.ts` is opt-in and **spends real GPU credits**. It stays skipped unless
`CHUTES_RUN_LIVE=1` plus `CHUTES_API_KEY` and `CHUTES_LIVE_IMAGE_MODEL` are set. Never enable it in
CI and never run it without the maintainer asking.

## Do not modify

- `dist/`, `coverage/` — build and coverage output, git-ignored, regenerated by `npm run build` /
  `npm run test:coverage`.
- `package-lock.json` — regenerate via npm, never by hand.
- `assets/chutes/` — generated media from local runs, git-ignored.
- `assets/chutes-media-mcp.png` — the project logo. It **incorporates Chutes marks that are not
  MIT-licensed** (see `NOTICE` and the README's third-party section). Do not edit, redraw, rename,
  move, recompress or replace it, and keep it excluded from the npm tarball.

## Delicate areas — change only with tests

These enforce the security boundaries introduced in 2.0.0 and the credential fixes in 1.2.2. Treat
any change here as security-relevant and keep the regression tests in `test/credential-scope.test.ts`
passing.

- `core/chutes-client.ts`: `isChutesHost`, `isSecureChutesUrl`, `isSafeAssetUrl`, `isPublicIpv4`,
  `isPublicIpv6`, `assertPublicAssetDestination`, the manual redirect loop in `download`, and
  `readResponseBytes`. The API key may only ever reach **HTTPS `chutes.ai` / `*.chutes.ai`** hosts.
  A bare `endsWith("chutes.ai")` once leaked the key to lookalike domains — do not reintroduce it.
- `core/media-engine.ts`: `isInsideWorkspace`, `prepareOutputDirectory`, `assertSafeOverwriteTarget`,
  `maybeEncodeFile`, `validateFilename`, `base64ToBytes`. Params come straight from a third-party
  model, so every path must be real-path-contained inside the workspace before any read or write.
- Regex added anywhere in `src/` must be linear-time. Two polynomial patterns were replaced with
  bounded scans in 2.0.1 after CodeQL findings (`sanitize`, `stripLeadingSlashes`, `parseApiBaseUrl`).

## Compatibility rules (anti-breaking-change)

Nothing below may change without an explicit, authorised **major** version bump:

- The three MCP tool names and their input field names (`list_media_models`,
  `describe_media_model`, `generate_media` with `model`, `kind`, `params`, `cord`, `output_dir`,
  `filename`, `timeout_ms`, `overwrite`).
- The CLI commands and flags (`list`, `describe`, `generate`, `install-skill`; `--kind`, `--query`,
  `--model`, `--limit`, `--params`, `--cord`, `--output`, `--filename`, `--timeout`, `--overwrite`,
  `--project`).
- The exported surface in `src/index.ts` and the shape of `GenerateResult`.
- The two bin names, `engines.node`, and the default output directory `assets/chutes/<kind>/`.
- Defaults that users depend on (`CHUTES_*` defaults listed in the README).

Additive, optional fields and new env vars with safe defaults are fine in a **minor** release.

## Environment variables

`CHUTES_API_KEY` is the only required variable. Optional: `CHUTES_AUTH_SCHEME`,
`CHUTES_API_BASE_URL`, `CHUTES_OUTPUT_DIR`, `CHUTES_WARMUP`, `CHUTES_COLD_START_RETRIES`,
`CHUTES_COLD_START_BACKOFF_MS`, `CHUTES_MAX_ASSET_MB`, `CHUTES_PROGRESS_INTERVAL_MS`,
`CHUTES_ALLOW_UNKNOWN_PARAMS`, `CHUTES_PROVENANCE`. All parsing lives in `core/config.ts`; keep the
README table, `skill/chutes-media/references/workflow.md` and that file in sync when adding one.

There is intentionally **no `.env` / `.env.example`**: the key is supplied by the MCP client's `env`
block or the shell, and is never written to disk. Do not add dotenv loading.

## Security rules

- Never log, print, commit, or embed a real API key. Use `cpk_...` placeholders in docs, issues and
  tests.
- Never widen the credential host check, never re-enable automatic redirect following on
  credential-bearing requests, and never remove the workspace containment checks.
- Never write outside the workspace, and never overwrite an existing asset without the explicit
  `overwrite` option.
- `.gitignore` blocks `.env*`, `*.key`, `*.pem`, `.npmrc` and `*.tgz`. If you find a secret tracked
  by mistake, report it and remove it from tracking — **do not rewrite git history**.

## Pinned dependencies — do not "upgrade" blindly

- **`overrides.esbuild = "0.28.1"`** resolves `GHSA-g7r4-m6w7-qqqr`; tsup still declares
  `esbuild ^0.27.0`, so npm cannot auto-fix. It is coupled with the **`allowScripts` entry
  `"esbuild@0.28.1"`**, which is the npm field that permits that dependency's install script (npm
  blocks dependency install scripts by default). **Both must be updated together**, or installs
  silently skip esbuild's install script. Remove the pair only once tsup ships a non-vulnerable range.
- **`@types/node ^20.19.43`** is pinned to the _minimum supported_ Node version on purpose. Dependabot
  bumps to 26.x were reverted by `fix: align Node runtime requirements`. Do not raise it while
  `engines.node` is `>=20.3`.
- **`zod ^3`** — the MCP SDK's schema API expects v3. Do not move to v4.
- **`typescript ^6`** — a v7 bump was evaluated and closed (PR #8). Leave it.
- Dependabot **version-update PRs are intentionally disabled** (`chore: stop Dependabot version-update
PRs`). Do not re-add `.github/dependabot.yml`.
- **CodeQL uses GitHub's default setup.** Do not add a `codeql.yml` workflow — it conflicts.

## Versioning and release

SemVer. The version lives in **`package.json` only**; `src/mcp/server.ts` reads it at runtime through
`createRequire`. **Never duplicate the version as a literal** — a hand-kept copy once drifted and the
server announced `1.2.0` while npm shipped `1.2.1`.

When bumping, update together:

1. `package.json` `version`
2. `CITATION.cff` `version` and `date-released`
3. `CHANGELOG.md` (Keep a Changelog format, real dates, plus the link refs at the bottom)

Then, after the change is merged to `main`: `git tag vX.Y.Z` → push the tag → `gh release create` →
`npm publish`.

**What ships to npm** is controlled by `files`: `dist`, `skill`, `LICENSE`, `NOTICE`, `README.md`.
Editing `README.md` or anything under `skill/` therefore changes the _published package_, so those
edits warrant at least a patch release. `AGENTS.md`, `src/`, `test/` and the repo config are not
shipped. Always confirm with `npm pack --dry-run` before releasing.

Publishing is **manual by the maintainer** using their `~/.npmrc` credentials. There is no release
workflow and no `NPM_TOKEN` repository secret — do not add one or invent credentials.

## Git and GitHub workflow

- Branch `main` is **protected**: pull request required, **1 approving review**, and the
  `build-and-test (20)` / `build-and-test (22)` checks must pass. Linear history is enforced and force
  pushes are blocked.
- Work on a dedicated branch and open a PR with `gh pr create`. Do not push straight to `main`, do not
  force-push, do not rewrite history, and never bypass hooks or checks (`--no-verify` and friends are
  forbidden).
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`). Security-relevant
  fixes use `fix(security):`.
- `CODEOWNERS` assigns everything to `@TheStreamCode`.

## Coding conventions

- TypeScript strict, ESM, `node:`-prefixed builtin imports, explicit `.js` extensions on relative
  imports (required by ESM output).
- `import type` for type-only imports (`@typescript-eslint/consistent-type-imports` is an error).
  Floating and misused promises are errors too.
- Prettier is authoritative for formatting (`printWidth: 100`, `proseWrap: preserve`). Run
  `npm run format` rather than hand-aligning.
- Errors: throw `ChutesError` (with an actionable `hint` where useful) or `ConfigError`; both are
  flattened for the user by `present.ts`'s `formatError`. Never leak raw stack traces to the agent.
- Unit tests (`src/**/*.test.ts`) inject a fake `fetch`/resolver so they run fully offline. Add tests
  for every behavioural change — the coverage gate will otherwise fail.

## Visibility rules

This repository is **public** and MIT-licensed. Consequently:

- Nothing internal, personal, customer-related or credential-bearing may be committed, and no private
  endpoints or hostnames may appear in code, docs or tests.
- Documentation must stay accurate and verifiable: no invented badges, statistics, screenshots,
  benchmarks, roadmaps or links. Every documented command must exist in `package.json` or the CLI.
- The project is **not affiliated with or endorsed by Chutes**. Keep that disclaimer in the README and
  `NOTICE`, and never imply an official relationship or use Chutes branding beyond the existing logo.
- Never change repository visibility.

## Checklist before proposing a change

1. `npm run check` passes (format, lint, types, tests + coverage thresholds, build).
2. `npm audit --omit=dev --audit-level=high` is clean.
3. `npm pack --dry-run` shows the expected 13 files and no source, tests, `.env`, tarball or logo.
4. Docs updated where behaviour changed: `README.md`, `skill/chutes-media/SKILL.md`,
   `skill/chutes-media/references/workflow.md`, `SECURITY.md`, `CHANGELOG.md`.
5. No secrets in the diff; no version literal duplicated; no new dependency without justification.
