import { describe, expect, it } from "vitest";
import { validateParams } from "./schema-validate.js";

const schema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string" },
    width: { type: "integer" },
  },
};

describe("validateParams", () => {
  it("passes a valid payload", () => {
    expect(validateParams({ prompt: "a cat", width: 512 }, schema)).toEqual({ valid: true, errors: [] });
  });

  it("reports a missing required field", () => {
    const res = validateParams({ width: 512 }, schema);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/missing required field "prompt"/);
  });

  it("reports a type mismatch", () => {
    const res = validateParams({ prompt: "x", width: "big" }, schema);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/width/);
  });

  it("passes when there is no usable schema", () => {
    expect(validateParams({ anything: 1 }, undefined).valid).toBe(true);
    expect(validateParams({ anything: 1 }, {}).valid).toBe(true);
  });

  it("does not block on an uncompilable schema", () => {
    expect(validateParams({ a: 1 }, { type: "not-a-real-type" }).valid).toBe(true);
  });

  it("allows unknown fields by default but rejects them in strict mode", () => {
    expect(validateParams({ prompt: "x", bogus: 1 }, schema).valid).toBe(true);
    const strict = validateParams({ prompt: "x", bogus: 1 }, schema, { strict: true });
    expect(strict.valid).toBe(false);
    expect(strict.errors.join(" ")).toMatch(/unexpected field "bogus"/);
  });
});
