#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ChutesClient } from "../core/chutes-client.js";
import { loadConfig } from "../core/config.js";
import { MediaEngine, type GenerateOptions } from "../core/media-engine.js";
import { describeView, formatError, listView } from "../core/present.js";
import type { ChutesConfig, ProgressEvent } from "../core/types.js";

// --- Lazy engine (so the server starts even before CHUTES_API_KEY is set) ---
let engine: MediaEngine | undefined;
let config: ChutesConfig | undefined;
function getEngine(): MediaEngine {
  if (!engine) {
    config = loadConfig();
    engine = new MediaEngine(new ChutesClient(config), config);
  }
  return engine;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
}

const INSTRUCTIONS = `Generate media (image, video, music, speech) via Chutes and save it into the user's project.

Workflow — always:
1. list_media_models — find a model for the kind (image | video | music | speech).
2. describe_media_model — ALWAYS call before generating an unfamiliar model; it returns the model's
   live cords with required fields, types, defaults and a ready-to-fill example.
3. generate_media — compose a FLAT params payload from the cord's example and submit it.

The saved file path is returned — reference it from the project (embed/import it). To edit existing
media, pass a workspace file path in params (e.g. image, mask, image_b64s); the server reads and
base64-encodes it. Cold-start 503s are retried automatically. Default output: ./assets/chutes/<kind>/.
Never hardcode payloads — describe first.`;

// Read from package.json rather than duplicating the literal: the hand-kept
// copy silently drifted (server announced 1.2.0 while npm shipped 1.2.1).
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const server = new McpServer({ name: "chutes-media-mcp", version }, { instructions: INSTRUCTIONS });

server.registerTool(
  "list_media_models",
  {
    title: "List Chutes media models",
    description:
      "List available Chutes media-generation models (image / video / music / speech), " +
      "optionally filtered by kind or a free-text query. Use this to discover a model, then " +
      "call describe_media_model before generate_media.",
    inputSchema: {
      kind: z.enum(["image", "video", "music", "speech"]).optional(),
      query: z.string().max(200).optional().describe("Free-text filter on the model name."),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ kind, query, limit }) => {
    try {
      const models = await getEngine().list({ kind, query, limit });
      return ok({ count: models.length, models: listView(models) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "describe_media_model",
  {
    title: "Describe a Chutes media model",
    description:
      "Fetch a model's live cords and input schemas so you can compose a valid request. " +
      "ALWAYS call this before generate_media for an unfamiliar model. Returns every cord " +
      "(e.g. generate, and img2img/inpaint when present) with its required fields, types, " +
      "defaults and a minimal example payload.",
    inputSchema: {
      model: z.string().min(1).max(512).describe("Model name/slug, e.g. owner/model-slug."),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ model }) => {
    try {
      return ok(describeView(await getEngine().describe(model)));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "generate_media",
  {
    title: "Generate media with Chutes",
    description:
      "Run a generation and save the asset into the workspace. `params` is the payload you " +
      "composed from describe_media_model. For editing, `params` may reference workspace file " +
      "paths (e.g. image, mask) which the server reads and encodes. The asset is saved under " +
      "output_dir (default ./assets/chutes/<kind>/) and the saved path is returned. Long video/" +
      "music jobs block with progress updates.",
    inputSchema: {
      model: z.string().min(1).max(512),
      kind: z.enum(["image", "video", "music", "speech"]),
      params: z.record(z.unknown()).describe("Payload matching the cord's input schema."),
      cord: z
        .string()
        .max(200)
        .optional()
        .describe("Operation/cord (e.g. img2img); defaults to the primary one."),
      output_dir: z.string().max(1_024).optional().describe("Output directory relative to CWD."),
      filename: z.string().min(1).max(255).optional(),
      timeout_ms: z.number().int().positive().max(2_147_483_647).optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Explicitly replace an existing asset and sidecar."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ model, kind, params, cord, output_dir, filename, timeout_ms, overwrite }, extra) => {
    const progressToken = extra._meta?.progressToken;
    let lastProgress = 0;
    const onProgress = (e: ProgressEvent) => {
      if (progressToken === undefined) return;
      let progress = e.progress ?? lastProgress + 0.01;
      if (progress <= lastProgress) progress = lastProgress + 0.001;
      lastProgress = Math.min(progress, 1);
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: lastProgress, total: 1, message: e.message },
        })
        .catch(() => {
          // A disconnected client must not turn progress reporting into an unhandled rejection.
        });
    };

    try {
      const opts: GenerateOptions = {
        model,
        kind,
        params,
        cord,
        outputDir: output_dir,
        filename,
        timeoutMs: timeout_ms,
        overwrite,
        signal: extra.signal,
        onProgress,
      };
      return ok(await getEngine().generate(opts));
    } catch (err) {
      return fail(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the JSON-RPC channel; logs go to stderr only.
  console.error("chutes-media-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
