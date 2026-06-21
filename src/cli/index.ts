#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ChutesClient } from "../core/chutes-client.js";
import { loadConfig } from "../core/config.js";
import { MediaEngine } from "../core/media-engine.js";
import { describeView, formatError, listView } from "../core/present.js";
import { MEDIA_KINDS, type MediaKind } from "../core/types.js";

const USAGE = `chutes-media — generate media through Chutes from the shell

Usage:
  chutes-media list [--kind <image|video|music|speech>] [--query <text>] [--limit <n>]
  chutes-media describe <model>
  chutes-media generate --kind <k> --model <m> --params <json|@file> [--cord <c>]
                        [--output <dir>] [--filename <name>] [--timeout <ms>]
  chutes-media install-skill [--project]

Notes:
  - Set CHUTES_API_KEY in your environment first.
  - Progress is printed to stderr; the JSON result is printed to stdout.
  - --params accepts inline JSON, @path/to/file.json, or a path to a .json file.
  - Models are not hardcoded: discover them with \`list\`, inspect with \`describe\`.
  - install-skill copies the bundled agent skill into your skills directory
    (~/.claude/skills by default, or ./.claude/skills with --project).
`;

function buildEngine(): MediaEngine {
  const config = loadConfig();
  return new MediaEngine(new ChutesClient(config), config);
}

function emitProgress(stage: string, message: string) {
  process.stderr.write(`  [${stage}] ${message}\n`);
}

/** Print a machine-readable result to stdout. */
function printResult(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(err: unknown): never {
  const message = formatError(err);
  process.stderr.write(`error: ${message}\n`);
  printResult({ error: message });
  process.exit(1);
}

function loadParams(value: string): Record<string, unknown> {
  let text = value;
  const filePath = value.startsWith("@") ? value.slice(1) : value;
  if (value.startsWith("@") || (existsSync(filePath) && filePath.toLowerCase().endsWith(".json"))) {
    text = readFileSync(path.resolve(filePath), "utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`--params is not valid JSON (and not a readable .json file): ${value}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function asKind(value: string | undefined): MediaKind {
  if (value && (MEDIA_KINDS as readonly string[]).includes(value)) return value as MediaKind;
  throw new Error(`--kind must be one of: ${MEDIA_KINDS.join(", ")}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      query: { type: "string" },
      model: { type: "string" },
      limit: { type: "string" },
      params: { type: "string" },
      cord: { type: "string" },
      output: { type: "string" },
      filename: { type: "string" },
      timeout: { type: "string" },
      project: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }

  switch (cmd) {
    case "list": {
      const models = await buildEngine().list({
        kind: values.kind ? asKind(values.kind) : undefined,
        query: values.query,
        limit: values.limit ? Number(values.limit) : undefined,
      });
      printResult({ count: models.length, models: listView(models) });
      return;
    }

    case "describe": {
      const model = values.model ?? positionals[1];
      if (!model) throw new Error("describe requires a model: chutes-media describe <model>");
      printResult(describeView(await buildEngine().describe(model)));
      return;
    }

    case "generate": {
      if (!values.model) throw new Error("generate requires --model");
      if (!values.params) throw new Error("generate requires --params");
      const kind = asKind(values.kind);
      const result = await buildEngine().generate({
        model: values.model,
        kind,
        params: loadParams(values.params),
        cord: values.cord,
        outputDir: values.output,
        filename: values.filename,
        timeoutMs: values.timeout ? Number(values.timeout) : undefined,
        onProgress: (e) => emitProgress(e.stage, e.message),
      });
      printResult(result);
      return;
    }

    case "install-skill": {
      const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const src = path.join(pkgRoot, "skill", "chutes-media");
      if (!existsSync(src)) throw new Error(`Bundled skill not found at ${src}`);
      const base = values.project
        ? path.resolve(process.cwd(), ".claude", "skills")
        : path.join(os.homedir(), ".claude", "skills");
      const dest = path.join(base, "chutes-media");
      await cp(src, dest, { recursive: true });
      emitProgress("installed", dest);
      printResult({ installed: dest });
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run \`chutes-media --help\`.`);
  }
}

main().catch(die);
