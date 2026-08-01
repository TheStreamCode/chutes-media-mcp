import { describe, expect, it } from "vitest";
import { ChutesError } from "./chutes-client.js";
import { ConfigError } from "./config.js";
import { describeView, formatError, listView } from "./present.js";
import type { ChuteDetail } from "./types.js";

describe("formatError", () => {
  it("presents known and unknown errors without leaking object internals", () => {
    expect(formatError(new ChutesError("request failed", { hint: "retry" }))).toBe(
      "request failed\nHint: retry",
    );
    expect(formatError(new ConfigError("bad config"))).toBe("bad config");
    expect(formatError(new Error("plain"))).toBe("plain");
    expect(formatError("string failure")).toBe("string failure");
  });
});

describe("describeView", () => {
  it("turns a live schema into fields and a useful example", () => {
    const detail: ChuteDetail = {
      name: "owner/model",
      kind: "image",
      tagline: "Image model",
      invokeBaseUrl: "https://owner-model.chutes.ai",
      cords: [
        {
          name: "generate",
          path: "/generate",
          method: "POST",
          stream: false,
          outputContentType: "image/png",
          inputSchema: {
            type: "object",
            required: ["prompt", "width", "tags", "nested", "nullable", "options"],
            properties: {
              prompt: { type: "string", description: "Generation prompt" },
              width: { type: "integer", minimum: 256, maximum: 2048 },
              format: { type: "string", enum: ["png", "jpeg"] },
              enabled: { type: "boolean", default: true },
              tags: { type: "array", items: { type: "string" } },
              nested: { $ref: "#/$defs/Nested" },
              nullable: { anyOf: [{ type: "null" }, { type: "number" }] },
              options: { type: "object" },
            },
            $defs: {
              Nested: {
                type: "object",
                required: ["caption"],
                properties: { caption: { type: "string" } },
              },
            },
          },
        },
        { name: "img2img", path: "/img2img", method: "POST", stream: false },
      ],
      raw: {},
    };

    const view = describeView(detail);
    expect(view).toMatchObject({
      model: "owner/model",
      kind: "image",
      supportsEditing: true,
    });
    expect(view.cords[0]).toMatchObject({
      name: "generate",
      required: ["prompt", "width", "tags", "nested", "nullable", "options"],
      fields: {
        prompt: { type: "string", description: "Generation prompt" },
        width: { type: "integer", minimum: 256, maximum: 2048 },
        format: { enum: ["png", "jpeg"] },
      },
      example: {
        prompt: "your text here",
        width: 256,
        enabled: true,
        tags: [""],
        nested: { caption: "your text here" },
        nullable: 0,
        options: {},
      },
    });
  });

  it("stops safely when local schema references form a cycle", () => {
    const detail: ChuteDetail = {
      name: "recursive",
      cords: [
        {
          name: "generate",
          path: "/generate",
          method: "POST",
          stream: false,
          inputSchema: {
            $ref: "#/$defs/Loop",
            $defs: { Loop: { $ref: "#/$defs/Loop" } },
          },
        },
      ],
      raw: {},
    };
    expect(describeView(detail).cords[0]?.example).toEqual({});
  });
});

describe("listView", () => {
  it("keeps the public summary and marks unknown kinds", () => {
    expect(
      listView([{ name: "model" }, { name: "image", kind: "image", tagline: "fast" }]),
    ).toEqual([
      { name: "model", kind: "unknown", tagline: undefined },
      { name: "image", kind: "image", tagline: "fast" },
    ]);
  });
});
