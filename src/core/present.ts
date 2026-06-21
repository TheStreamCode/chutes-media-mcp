import { ChutesError } from "./chutes-client.js";
import { ConfigError } from "./config.js";
import type { ChuteDetail, ChuteSummary, JsonSchema } from "./types.js";

/** Flatten any error into a single actionable line for an agent/CLI. */
export function formatError(err: unknown): string {
  if (err instanceof ChutesError) {
    return err.hint ? `${err.message}\nHint: ${err.hint}` : err.message;
  }
  if (err instanceof ConfigError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface CordView {
  name: string;
  method: string;
  stream: boolean;
  outputContentType?: string;
  required: string[];
  fields: Record<string, FieldView>;
  example: Record<string, unknown>;
}

export interface FieldView {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface DescribeView {
  model: string;
  kind?: string;
  tagline?: string;
  invokeBaseUrl?: string;
  cords: CordView[];
  /** True if any cord performs editing (img2img/inpaint/…). */
  supportsEditing: boolean;
}

const EDIT_CORD_NAMES = ["img2img", "inpaint", "image2image", "outpaint", "edit"];

/** Build the structured describe output the agent uses to compose a payload. */
export function describeView(detail: ChuteDetail): DescribeView {
  const cords = detail.cords.map((c) => cordView(c.inputSchema, {
    name: c.name,
    method: c.method,
    stream: c.stream,
    outputContentType: c.outputContentType ?? undefined,
  }));
  return {
    model: detail.name,
    kind: detail.kind,
    tagline: detail.tagline,
    invokeBaseUrl: detail.invokeBaseUrl,
    cords,
    supportsEditing: detail.cords.some((c) => EDIT_CORD_NAMES.includes(c.name.toLowerCase())),
  };
}

function cordView(
  schema: JsonSchema | undefined,
  base: Pick<CordView, "name" | "method" | "stream" | "outputContentType">,
): CordView {
  const root = isObject(schema) ? schema : {};
  const top = resolveRef(root, root);
  const props = isObject(top.properties) ? (top.properties as Record<string, unknown>) : {};
  const required = Array.isArray(top.required) ? (top.required as string[]) : [];
  const fields: Record<string, FieldView> = {};
  for (const [key, rawValue] of Object.entries(props)) {
    const raw = resolveRef(rawValue, root);
    fields[key] = {
      type: schemaType(raw),
      description: typeof raw.description === "string" ? raw.description : undefined,
      default: raw.default,
      enum: Array.isArray(raw.enum) ? raw.enum : undefined,
      minimum: typeof raw.minimum === "number" ? raw.minimum : undefined,
      maximum: typeof raw.maximum === "number" ? raw.maximum : undefined,
    };
  }
  const example = buildExample(top, root, "", 0);
  return { ...base, required, fields, example: isObject(example) ? example : {} };
}

/**
 * A minimal example payload: required fields plus any with a default, resolving
 * internal $ref/definitions so nested Pydantic-style models (e.g. `input_args`)
 * are expanded into something the agent can actually fill in.
 */
function buildExample(node: unknown, root: Record<string, unknown>, keyHint: string, depth: number): unknown {
  const s = resolveRef(node, root);
  const props = isObject(s.properties) ? (s.properties as Record<string, unknown>) : undefined;
  if (props && depth < 6) {
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const keys = new Set<string>(required);
    for (const [key, raw] of Object.entries(props)) {
      const r = resolveRef(raw, root);
      if (r.default !== undefined) keys.add(key);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = buildExample(props[key], root, key, depth + 1);
    return out;
  }
  return placeholderFor(s, keyHint, root, depth);
}

function placeholderFor(
  field: Record<string, unknown>,
  key: string,
  root: Record<string, unknown>,
  depth: number,
): unknown {
  if (field.default !== undefined) return field.default;
  if (Array.isArray(field.enum) && field.enum.length > 0) return field.enum[0];
  switch (schemaType(field)) {
    case "integer":
    case "number":
      return typeof field.minimum === "number" ? field.minimum : 0;
    case "boolean":
      return false;
    case "array": {
      const items = isObject(field.items) ? field.items : undefined;
      return items && depth < 6 ? [buildExample(items, root, key, depth + 1)] : [];
    }
    case "object":
      return {};
    case "null":
      return null;
    default:
      return /prompt|text|caption|lyric/i.test(key) ? "your text here" : "";
  }
}

/** Type of a schema node, looking through anyOf/oneOf (e.g. [integer, null]). */
function schemaType(field: Record<string, unknown>): string | undefined {
  if (typeof field.type === "string") return field.type;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const arr = field[key];
    if (Array.isArray(arr)) {
      for (const sub of arr) {
        if (isObject(sub) && typeof sub.type === "string" && sub.type !== "null") return sub.type;
      }
    }
  }
  return undefined;
}

/** Resolve an internal `#/definitions/...` or `#/$defs/...` $ref against the root schema. */
function resolveRef(node: unknown, root: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(node)) return {};
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let cur: unknown = root;
    for (const seg of ref.slice(2).split("/")) {
      if (!isObject(cur)) return node;
      cur = cur[seg];
    }
    if (isObject(cur)) return resolveRef(cur, root);
  }
  return node;
}

export function listView(models: ChuteSummary[]): Array<Record<string, unknown>> {
  return models.map((m) => ({
    name: m.name,
    kind: m.kind ?? "unknown",
    tagline: m.tagline,
  }));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
