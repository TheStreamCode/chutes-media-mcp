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
    const ff = fakeFetch(() =>
      json([{ name: "a", slug: "a", username: "u", tagline: "FLUX image" }]),
    );
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
          {
            name: "img",
            tagline: "diffusion",
            cords: [{ public_api_path: "/generate", output_content_type: "image/png" }],
          },
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
            input_schema: {
              type: "object",
              required: ["prompt"],
              properties: { prompt: { type: "string" } },
            },
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

  it("normalizes a bare subdomain field", async () => {
    const ff = fakeFetch(() => json({ name: "m", subdomain: "owner-model", cords: [] }));
    const detail = await new ChutesClient(makeConfig(), ff).describe("m");
    expect(detail.invokeBaseUrl).toBe("https://owner-model.chutes.ai");
  });

  it("trims catalog URL delimiters with bounded scans", async () => {
    const longPath = `${"/".repeat(20_000)}x`;
    const ff = fakeFetch(() =>
      json({ name: "m", invocation_url: `https://owner.chutes.ai/${longPath}`, cords: [] }),
    );
    const detail = await new ChutesClient(makeConfig(), ff).describe("m");
    expect(detail.invokeBaseUrl).toBe(`https://owner.chutes.ai/${longPath}`);

    const dotted = fakeFetch(() =>
      json({ name: "m", subdomain: `${".".repeat(128)}owner-model${".".repeat(128)}`, cords: [] }),
    );
    const normalized = await new ChutesClient(makeConfig(), dotted).describe("m");
    expect(normalized.invokeBaseUrl).toBe("https://owner-model.chutes.ai");
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

  it("never sends the Chutes key to a custom management endpoint", async () => {
    const ff = fakeFetch(() => json([]));
    const config = makeConfig({ apiBaseUrl: "https://proxy.example/api" });
    await new ChutesClient(config, ff).list();
    expect(authOf(ff.calls[0]!.init)).toBeUndefined();
  });

  it("bounds management JSON responses before parsing", async () => {
    const ff = fakeFetch(() => json([{ name: "too-large" }]));
    const client = new ChutesClient(makeConfig({ maxAssetBytes: 2 }), ff);
    await expect(client.list()).rejects.toThrow(/asset limit/);
  });

  it("maps malformed management JSON to a ChutesError", async () => {
    const ff = fakeFetch(
      () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    );
    await expect(new ChutesClient(makeConfig(), ff).list()).rejects.toMatchObject({
      name: "ChutesError",
      message: "Chutes returned an invalid JSON response.",
    });
  });

  it("returns raw bytes and content type from a cord invoke", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const ff = fakeFetch(
      () => new Response(payload, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    const res = await client.invoke({
      url: "https://u-s.chutes.ai/generate",
      body: { prompt: "x" },
    });
    expect(res.contentType).toBe("image/jpeg");
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4]);
    expect(ff.calls[0]!.init?.method).toBe("POST");
    expect(ff.calls[0]!.init?.redirect).toBe("error");
  });

  it("rejects responses larger than the configured in-memory limit", async () => {
    const ff = fakeFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
        }),
    );
    const client = new ChutesClient(makeConfig({ maxAssetBytes: 2 }), ff);
    await expect(
      client.invoke({ url: "https://u-s.chutes.ai/generate", body: {} }),
    ).rejects.toThrow(/asset limit/);
  });

  it("never sends the API key to an untrusted invocation URL", async () => {
    const ff = fakeFetch(() => json({}));
    const client = new ChutesClient(makeConfig(), ff);
    await expect(
      client.invoke({ url: "https://attacker.example/generate", body: { prompt: "x" } }),
    ).rejects.toThrow(/untrusted invocation URL/);
    expect(ff.calls).toHaveLength(0);
  });
});

describe("ChutesClient.download", () => {
  it("blocks explicit private-network asset URLs before fetch", async () => {
    const ff = fakeFetch(
      () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    await expect(client.download("https://127.0.0.1/private.png")).rejects.toThrow(/unsafe URL/);
    expect(ff.calls).toHaveLength(0);
  });

  it("blocks external hosts whose DNS resolves to a private address", async () => {
    const ff = fakeFetch(
      () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
    const client = new ChutesClient(makeConfig(), ff, () => Promise.resolve(["10.0.0.8"]));
    await expect(client.download("https://assets.example/private.png")).rejects.toThrow(
      /non-public network/,
    );
    expect(ff.calls).toHaveLength(0);
  });

  it("validates every redirect destination", async () => {
    const ff = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://[::1]/secret" } }),
    );
    const client = new ChutesClient(makeConfig(), ff);
    await expect(client.download("https://cdn.chutes.ai/start")).rejects.toThrow(/unsafe URL/);
    expect(ff.calls).toHaveLength(1);
  });

  it("redacts signed query parameters from network errors", async () => {
    const signedUrl = "https://assets.example/output.png?token=super-secret#fragment";
    const ff = fakeFetch(() => {
      throw new Error(`fetch failed for ${signedUrl}`);
    });
    const client = new ChutesClient(makeConfig(), ff, () => Promise.resolve(["8.8.8.8"]));

    try {
      await client.download(signedUrl);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChutesError);
      const message = (error as Error).message;
      expect(message).toContain("https://assets.example/output.png");
      expect(message).not.toContain("super-secret");
      expect(message).not.toContain("fragment");
    }
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

  it("does not retain an oversized error body", async () => {
    const ff = fakeFetch(() => json({ detail: "sensitive oversized body" }, 500));
    const client = new ChutesClient(makeConfig({ maxAssetBytes: 2 }), ff);
    try {
      await client.list();
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ name: "ChutesError", status: 500, body: undefined });
      expect((err as Error).message).not.toContain("sensitive");
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
      inferKind({
        cords: [
          {
            name: "g",
            path: "/generate",
            method: "POST",
            stream: false,
            outputContentType: "video/mp4",
          },
        ],
      }),
    ).toBe("video");
  });
});
