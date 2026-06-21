import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { ChutesClient, ChutesError, inferKind, type FetchLike } from "./chutes-client.js";
import type { ChutesConfig } from "./types.js";

function makeConfig(over: Partial<ChutesConfig> = {}): ChutesConfig {
  return { ...loadConfig({ CHUTES_API_KEY: "cpk_test" }), ...over };
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** Build a fake fetch that records calls and replies via a handler. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authOf(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe("ChutesClient.list", () => {
  it("sets discovery params and parses an array response", async () => {
    const ff = fakeFetch(() => json([{ name: "a", slug: "a", username: "u", tagline: "FLUX image" }]));
    const client = new ChutesClient(makeConfig(), ff);
    const out = await client.list({ query: "flux", limit: 10 });

    const url = new URL(ff.calls[0]!.url);
    expect(url.pathname).toBe("/chutes/");
    expect(url.searchParams.get("include_schemas")).toBe("false");
    expect(url.searchParams.get("name")).toBe("flux");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("image");
  });

  it("parses an {items:[...]} envelope and filters by kind", async () => {
    const ff = fakeFetch(() =>
      json({
        items: [
          { name: "img", tagline: "diffusion", cords: [{ public_api_path: "/generate", output_content_type: "image/png" }] },
          { name: "tts", tagline: "text-to-speech voice", cords: [{ public_api_path: "/speak" }] },
        ],
      }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    const speech = await client.list({ kind: "speech" });
    expect(speech.map((c) => c.name)).toEqual(["tts"]);
  });
});

describe("ChutesClient.describe", () => {
  it("parses cords, schemas and computes the invoke base URL", async () => {
    const ff = fakeFetch(() =>
      json({
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
          { public_api_path: "/img2img", stream: false },
        ],
      }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    const detail = await client.describe("myuser/my-image-gen");

    // The single-chute endpoint rejects include_schemas; it must not be sent.
    expect(new URL(ff.calls[0]!.url).searchParams.has("include_schemas")).toBe(false);
    expect(detail.invokeBaseUrl).toBe("https://myuser-my-image-gen.chutes.ai");
    expect(detail.cords.map((c) => c.name)).toEqual(["generate", "img2img"]);
    expect(detail.cords[0]!.inputSchema).toMatchObject({ required: ["prompt"] });
    expect(detail.kind).toBe("image");
  });
});

describe("ChutesClient auth + invoke", () => {
  it("sends the raw key by default", async () => {
    const ff = fakeFetch(() => json([]));
    await new ChutesClient(makeConfig(), ff).list();
    expect(authOf(ff.calls[0]!.init)).toBe("cpk_test");
  });

  it("sends a Bearer key when configured", async () => {
    const ff = fakeFetch(() => json([]));
    await new ChutesClient(makeConfig({ authScheme: "bearer" }), ff).list();
    expect(authOf(ff.calls[0]!.init)).toBe("Bearer cpk_test");
  });

  it("returns raw bytes and content type from a cord invoke", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const ff = fakeFetch(
      () => new Response(payload, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    const res = await client.invoke({ url: "https://u-s.chutes.ai/generate", body: { prompt: "x" } });
    expect(res.contentType).toBe("image/jpeg");
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4]);
    expect(ff.calls[0]!.init?.method).toBe("POST");
  });
});

describe("ChutesClient error mapping", () => {
  const cases: Array<[number, string]> = [
    [401, "Unauthorized"],
    [404, "Not found"],
    [422, "Invalid request"],
    [429, "Rate limited"],
    [500, "server error"],
  ];
  for (const [status, fragment] of cases) {
    it(`maps ${status} to a ChutesError mentioning "${fragment}"`, async () => {
      const ff = fakeFetch(() => json({ detail: "boom" }, status));
      const client = new ChutesClient(makeConfig(), ff);
      await expect(client.list()).rejects.toMatchObject({
        name: "ChutesError",
        status,
      });
      await expect(client.list()).rejects.toThrow(fragment);
    });
  }

  it("attaches an actionable hint on 401", async () => {
    const ff = fakeFetch(() => json({ detail: "nope" }, 401));
    try {
      await new ChutesClient(makeConfig(), ff).list();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChutesError);
      expect((err as ChutesError).hint).toMatch(/CHUTES_AUTH_SCHEME/);
    }
  });
});

describe("ChutesClient.warmup", () => {
  it("swallows errors so a warmup hiccup never blocks generation", async () => {
    const ff = fakeFetch(() => json({ detail: "cold" }, 500));
    const client = new ChutesClient(makeConfig(), ff);
    await expect(client.warmup("any")).resolves.toBeUndefined();
  });
});

describe("inferKind", () => {
  it("classifies common media chutes", () => {
    expect(inferKind({ tagline: "FLUX text-to-image", cords: [] })).toBe("image");
    expect(inferKind({ tagline: "Wan video generation", cords: [] })).toBe("video");
    expect(inferKind({ tagline: "DiffRhythm music", cords: [] })).toBe("music");
    expect(inferKind({ tagline: "CSM text-to-speech", cords: [] })).toBe("speech");
    expect(
      inferKind({ cords: [{ name: "g", path: "/generate", method: "POST", stream: false, outputContentType: "video/mp4" }] }),
    ).toBe("video");
  });
});