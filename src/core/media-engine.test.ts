import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChutesClient, type FetchLike } from "./chutes-client.js";
import { loadConfig } from "./config.js";
import {
  MediaEngine,
  assertContentTypeMatchesKind,
  extensionFor,
  hashSchema,
  resolveInputAssets,
  selectCord,
} from "./media-engine.js";
import type { ChuteDetail, ChutesConfig, ProgressEvent } from "./types.js";

function makeConfig(over: Partial<ChutesConfig> = {}): ChutesConfig {
  return {
    ...loadConfig({ CHUTES_API_KEY: "cpk_test" }),
    progressIntervalMs: 10,
    coldStartBackoffMs: 1,
    ...over,
  };
}

function tmpdir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "chutes-mcp-"));
}

// A router fake-fetch keyed by URL substring.
function router(routes: Array<[RegExp, (init?: RequestInit) => Response]>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push(url);
    for (const [re, make] of routes) if (re.test(url)) return make(init);
    return new Response("no route", { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function bytesResponse(bytes: number[], contentType: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const imageChute = {
  name: "my-image-gen",
  slug: "my-image-gen",
  username: "myuser",
  tagline: "FLUX diffusion",
  cords: [
    {
      public_api_path: "/generate",
      public_api_method: "POST",
      output_content_type: "image/jpeg",
      input_schema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } },
    },
    { public_api_path: "/img2img", public_api_method: "POST" },
  ],
};

describe("selectCord", () => {
  const detail: ChuteDetail = {
    name: "m",
    cords: [
      { name: "generate", path: "/generate", method: "POST", stream: false },
      { name: "img2img", path: "/img2img", method: "POST", stream: false },
    ],
    raw: {},
  };

  it("returns the requested cord by name or path", () => {
    expect(selectCord(detail, "image", "img2img").name).toBe("img2img");
    expect(selectCord(detail, "image", "/generate").name).toBe("generate");
  });

  it("throws with the available list for an unknown cord", () => {
    expect(() => selectCord(detail, "image", "nope")).toThrow(/Available: generate, img2img/);
  });

  it("auto-selects the primary generation cord, never the edit cord", () => {
    expect(selectCord(detail, "image").name).toBe("generate");
  });
});

describe("extensionFor", () => {
  it("maps known content types and falls back by kind", () => {
    expect(extensionFor("image/jpeg", "image")).toBe("jpg");
    expect(extensionFor("video/mp4", "video")).toBe("mp4");
    expect(extensionFor("audio/mpeg", "music")).toBe("mp3");
    expect(extensionFor("application/octet-stream", "speech")).toBe("wav");
  });
});

describe("resolveInputAssets", () => {
  it("encodes an existing file but leaves text fields alone", async () => {
    const dir = await tmpdir();
    const file = path.join(dir, "ref.png");
    await writeFile(file, new Uint8Array([1, 2, 3]));
    const out = await resolveInputAssets(
      { prompt: "a cat", image: "ref.png", missing: "nope.png" },
      dir,
      () => {},
    );
    expect(out.prompt).toBe("a cat");
    expect(out.image).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(out.missing).toBe("nope.png");
  });

  it("encodes file paths inside an array field (e.g. image_b64s)", async () => {
    const dir = await tmpdir();
    await writeFile(path.join(dir, "a.png"), new Uint8Array([1, 2, 3]));
    const out = await resolveInputAssets({ image_b64s: ["a.png"] }, dir, () => {});
    expect(out.image_b64s).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
  });
});

describe("assertContentTypeMatchesKind", () => {
  it("passes matching families and opaque types", () => {
    expect(() => assertContentTypeMatchesKind("image/png", "image")).not.toThrow();
    expect(() => assertContentTypeMatchesKind("audio/mpeg", "music")).not.toThrow();
    expect(() => assertContentTypeMatchesKind("application/octet-stream", "video")).not.toThrow();
  });
  it("throws on a clear mismatch", () => {
    expect(() => assertContentTypeMatchesKind("audio/mpeg", "image")).toThrow(/match the requested kind/);
  });
});

describe("hashSchema", () => {
  it("is stable regardless of key order", () => {
    const a = hashSchema({ type: "object", required: ["p"], properties: { p: { type: "string" } } });
    const b = hashSchema({ properties: { p: { type: "string" } }, required: ["p"], type: "object" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("MediaEngine.generate", () => {
  it("runs the full happy path and saves the asset", async () => {
    const dir = await tmpdir();
    const ff = router([
      [/\/chutes\/warmup\//, () => json({ status: "warm" })],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/myuser-my-image-gen\.chutes\.ai\/generate/, () => bytesResponse([255, 216, 255, 217], "image/jpeg")],
    ]);
    const engine = new MediaEngine(new ChutesClient(makeConfig(), ff), makeConfig());
    const events: ProgressEvent[] = [];
    const res = await engine.generate({
      model: "myuser/my-image-gen",
      kind: "image",
      params: { prompt: "a dragon" },
      cwd: dir,
      onProgress: (e) => events.push(e),
    });

    expect(res.cord).toBe("generate");
    expect(res.bytes).toBe(4);
    expect(res.contentType).toBe("image/jpeg");
    expect(res.path).toContain(path.join("assets", "chutes", "image"));
    expect(path.extname(res.path)).toBe(".jpg");
    const saved = await readFile(res.path);
    expect(Array.from(saved)).toEqual([255, 216, 255, 217]);
    expect(events.some((e) => e.stage === "warmup")).toBe(true);
    expect(events.some((e) => e.stage === "saved")).toBe(true);
    expect(ff.calls.some((u) => /warmup/.test(u))).toBe(true);
  });

  it("writes a provenance sidecar with the pinned schema hash", async () => {
    const dir = await tmpdir();
    const ff = router([
      [/\/chutes\/warmup\//, () => json({})],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/myuser-my-image-gen\.chutes\.ai\/generate/, () => bytesResponse([1, 2, 3], "image/jpeg")],
    ]);
    const engine = new MediaEngine(new ChutesClient(makeConfig(), ff), makeConfig());
    const res = await engine.generate({
      model: "myuser/my-image-gen",
      kind: "image",
      params: { prompt: "x" },
      cwd: dir,
    });
    expect(res.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.provenancePath).toBe(`${res.path}.json`);
    const sidecar = JSON.parse(await readFile(res.provenancePath!, "utf8"));
    expect(sidecar.model).toBe("myuser/my-image-gen");
    expect(sidecar.schemaHash).toBe(res.schemaHash);
    expect(sidecar.params).toEqual({ prompt: "x" });
  });

  it("rejects a 200 whose media type doesn't match the kind", async () => {
    const dir = await tmpdir();
    const ff = router([
      [/\/chutes\/warmup\//, () => json({})],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/myuser-my-image-gen\.chutes\.ai\/generate/, () => bytesResponse([1, 2, 3], "audio/mpeg")],
    ]);
    const engine = new MediaEngine(new ChutesClient(makeConfig(), ff), makeConfig());
    await expect(
      engine.generate({ model: "myuser/my-image-gen", kind: "image", params: { prompt: "x" }, cwd: dir }),
    ).rejects.toThrow(/match the requested kind/);
  });

  it("rejects an invalid payload without invoking the GPU cord", async () => {
    const dir = await tmpdir();
    const ff = router([
      [/\/chutes\/warmup\//, () => json({})],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/myuser-my-image-gen\.chutes\.ai/, () => bytesResponse([1], "image/jpeg")],
    ]);
    const engine = new MediaEngine(new ChutesClient(makeConfig(), ff), makeConfig());
    await expect(
      engine.generate({ model: "myuser/my-image-gen", kind: "image", params: {}, cwd: dir }),
    ).rejects.toThrow(/missing required field "prompt"/);
    expect(ff.calls.some((u) => /\.chutes\.ai\/generate/.test(u))).toBe(false);
  });

  it("retries a cold-start 503, re-warming, then succeeds", async () => {
    const dir = await tmpdir();
    let genCalls = 0;
    let warmups = 0;
    const ff = router([
      [/\/chutes\/warmup\//, () => { warmups++; return json({}); }],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [
        /myuser-my-image-gen\.chutes\.ai\/generate/,
        () => {
          genCalls++;
          return genCalls < 3
            ? json({ detail: "No instances available (yet)" }, 503)
            : bytesResponse([1, 2, 3], "image/jpeg");
        },
      ],
    ]);
    const cfg = makeConfig({ coldStartRetries: 3 });
    const engine = new MediaEngine(new ChutesClient(cfg, ff), cfg);
    const events: ProgressEvent[] = [];
    const res = await engine.generate({
      model: "myuser/my-image-gen",
      kind: "image",
      params: { prompt: "x" },
      cwd: dir,
      onProgress: (e) => events.push(e),
    });
    expect(res.bytes).toBe(3);
    expect(genCalls).toBe(3);
    expect(warmups).toBeGreaterThanOrEqual(3); // initial + one per retry
    expect(events.some((e) => e.stage === "cold-start")).toBe(true);
  });

  it("gives up after coldStartRetries and throws the 503", async () => {
    const dir = await tmpdir();
    let genCalls = 0;
    const ff = router([
      [/\/chutes\/warmup\//, () => json({})],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/myuser-my-image-gen\.chutes\.ai\/generate/, () => { genCalls++; return json({ detail: "No instances available" }, 503); }],
    ]);
    const cfg = makeConfig({ coldStartRetries: 1 });
    const engine = new MediaEngine(new ChutesClient(cfg, ff), cfg);
    await expect(
      engine.generate({ model: "myuser/my-image-gen", kind: "image", params: { prompt: "x" }, cwd: dir }),
    ).rejects.toMatchObject({ status: 503 });
    expect(genCalls).toBe(2); // initial attempt + 1 retry
  });

  it("follows a JSON result that carries an asset URL", async () => {
    const dir = await tmpdir();
    const ff = router([
      [/\/chutes\/warmup\//, () => json({})],
      [/api\.chutes\.ai\/chutes\//, () => json(imageChute)],
      [/\.chutes\.ai\/generate/, () => json({ url: "https://cdn.chutes.ai/out/abc.png" })],
      [/cdn\.chutes\.ai\/out\/abc\.png/, () => bytesResponse([9, 8, 7], "image/png")],
    ]);
    const engine = new MediaEngine(new ChutesClient(makeConfig(), ff), makeConfig());
    const res = await engine.generate({
      model: "myuser/my-image-gen",
      kind: "image",
      params: { prompt: "x" },
      cwd: dir,
    });
    expect(res.contentType).toBe("image/png");
    expect(res.bytes).toBe(3);
  });
});
