import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChutesClient, MediaEngine, loadConfig } from "../src/index.js";

/**
 * Live integration tests. Skipped unless you opt in:
 *
 *   $env:CHUTES_API_KEY = "cpk_..."
 *   $env:CHUTES_RUN_LIVE = "1"
 *   $env:CHUTES_LIVE_IMAGE_MODEL = "<owner>/<image-model-slug>"   # required for the image test
 *   $env:CHUTES_LIVE_VIDEO_MODEL = "<owner>/<video-model-slug>"   # optional, for the video test
 *   npx vitest run test/integration.test.ts
 *
 * Models are NOT hardcoded — the Chutes catalog changes; pass current slugs via env.
 */
const live = process.env.CHUTES_RUN_LIVE === "1" && !!process.env.CHUTES_API_KEY;

describe.skipIf(!live)("live Chutes integration", () => {
  const config = live ? loadConfig() : undefined;

  it("lists models", async () => {
    const client = new ChutesClient(config!);
    const models = await client.list({ limit: 5 });
    expect(Array.isArray(models)).toBe(true);
  });

  it.skipIf(!process.env.CHUTES_LIVE_IMAGE_MODEL)(
    "generates and saves an image (sync)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "chutes-live-"));
      const engine = new MediaEngine(new ChutesClient(config!), config!);
      const res = await engine.generate({
        model: process.env.CHUTES_LIVE_IMAGE_MODEL!,
        kind: "image",
        params: { prompt: "a serene mountain lake at sunrise, photorealistic" },
        cwd: dir,
        onProgress: (e) => process.stderr.write(`  [${e.stage}] ${e.message}\n`),
      });
      expect(res.bytes).toBeGreaterThan(0);
      expect(res.path).toContain(dir);
      process.stderr.write(`  saved ${res.path} (${res.bytes} bytes, ${res.durationMs}ms, cost=${res.cost ?? "n/a"})\n`);
    },
    180_000,
  );

  it.skipIf(!process.env.CHUTES_LIVE_VIDEO_MODEL)(
    "generates and saves a video (sync, long timeout)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "chutes-live-"));
      const engine = new MediaEngine(new ChutesClient(config!), config!);
      const res = await engine.generate({
        model: process.env.CHUTES_LIVE_VIDEO_MODEL!,
        kind: "video",
        params: { prompt: "a paper boat floating down a gentle stream" },
        cwd: dir,
        onProgress: (e) => process.stderr.write(`  [${e.stage}] ${e.message}\n`),
      });
      expect(res.bytes).toBeGreaterThan(0);
      process.stderr.write(`  saved ${res.path} (${res.bytes} bytes, ${res.durationMs}ms)\n`);
    },
    900_000,
  );
});
