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
 *
 * With `strict`, top-level fields not declared in the schema are rejected, so a
 * provider renaming a field (or a typo'd param) fails loudly instead of being
 * silently dropped by the server.
 */
export function validateParams(
  params: unknown,
  schema: JsonSchema | undefined,
  opts: { strict?: boolean } = {},
): ValidationResult {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }

  let effective = schema;
  if (opts.strict && hasOwnProperties(schema) && schema.additionalProperties === undefined) {
    // Only constrain the root object; nested models keep their own rules.
    effective = { ...schema, additionalProperties: false };
  }

  let validate;
  try {
    validate = ajv.compile(effective);
  } catch {
    // A schema we can't even compile shouldn't block a generation attempt.
    return { valid: true, errors: [] };
  }

  if (validate(params)) return { valid: true, errors: [] };
  return { valid: false, errors: (validate.errors ?? []).map(formatError) };
}

function hasOwnProperties(schema: JsonSchema): boolean {
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props).length > 0;
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
