import { Ajv, type ErrorObject } from "ajv";
import type { JsonSchema } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  /** Human-readable problems, ready to hand back to the agent. */
  errors: string[];
}

// Lenient on purpose: Chutes schemas come from many models and may use keywords
// or formats Ajv doesn't know. We only want required/type sanity, not pedantry.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
  coerceTypes: false,
});

/**
 * Light-validate an agent-composed payload against a cord's live JSON Schema.
 * If no usable schema is available, validation passes (nothing to check against).
 */
export function validateParams(params: unknown, schema: JsonSchema | undefined): ValidationResult {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch {
    // A schema we can't even compile shouldn't block a generation attempt.
    return { valid: true, errors: [] };
  }

  if (validate(params)) return { valid: true, errors: [] };
  return { valid: false, errors: (validate.errors ?? []).map(formatError) };
}

function formatError(err: ErrorObject): string {
  const where = err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
  if (err.keyword === "required") {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    return `missing required field "${missing}"`;
  }
  if (err.keyword === "additionalProperties") {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unexpected field "${extra}"`;
  }
  const field = where || "(root)";
  return `field "${field}" ${err.message ?? "is invalid"}`;
}
