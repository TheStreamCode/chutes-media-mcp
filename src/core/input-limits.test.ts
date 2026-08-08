import { describe, expect, it } from "vitest";
import { assertTextLength, INPUT_LIMITS } from "./input-limits.js";

describe("shared frontend input limits", () => {
  it("accepts bounded values and rejects oversized ones", () => {
    expect(assertTextLength("model", "model", INPUT_LIMITS.model)).toBe("model");
    expect(() =>
      assertTextLength("x".repeat(INPUT_LIMITS.query + 1), "query", INPUT_LIMITS.query),
    ).toThrow("query must be at most 200 characters");
  });
});
