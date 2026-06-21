import { authHeaderValue } from "./config.js";
import type {
  ChuteDetail,
  ChuteSummary,
  ChutesConfig,
  CordInfo,
  InvokeResult,
  JsonSchema,
  MediaKind,
} from "./types.js";

/** Minimal fetch shape so the client can be unit-tested without the network. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ChutesError extends Error {
  override name = "ChutesError";
  readonly status?: number;
  readonly hint?: string;
  readonly body?: unknown;

  constructor(message: string, opts: { status?: number; hint?: string; body?: unknown } = {}) {
    super(message);
    this.status = opts.status;
    this.hint = opts.hint;
    this.body = opts.body;
  }
}

interface ListParams {
  kind?: MediaKind;
  query?: string;
  limit?: number;
  page?: number;
  includeSchemas?: boolean;
}

interface InvokeParams {
  url: string;
  method?: string;
  /** JSON body to send. */
  body: unknown;
  /** External signal for timeout/cancellation, owned by the caller (engine). */
  signal?: AbortSignal;
}

const MANAGEMENT_TIMEOUT_MS = 30_000;

export class ChutesClient {
  private readonly config: ChutesConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: ChutesConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /** List media chutes, optionally filtered by kind / free-text query. */
  async list(params: ListParams = {}): Promise<ChuteSummary[]> {
    const url = new URL(`${this.config.apiBaseUrl}/chutes/`);
    url.searchParams.set("include_public", "true");
    url.searchParams.set("include_schemas", String(params.includeSchemas ?? false));
    if (params.query) url.searchParams.set("name", params.query);
    if (params.limit) url.searchParams.set("limit", String(params.limit));
    if (params.page) url.searchParams.set("page", String(params.page));

    const data = await this.getJson(url);
    const items = extractArray(data).map(parseSummary);
    return params.kind ? items.filter((c) => c.kind === params.kind) : items;
  }

  /**
   * Fetch a single chute with its cords and live input schemas.
   * Note: the single-chute endpoint returns schemas by default and rejects an
   * `include_schemas` query param (that flag belongs only to the list endpoint).
   */
  async describe(model: string): Promise<ChuteDetail> {
    const url = new URL(`${this.config.apiBaseUrl}/chutes/${encodeURIComponent(model)}`);
    const data = await this.getJson(url);
    return parseDetail(data);
  }

  /** Warm up a (possibly cold) chute. `quick=true` returns immediately. */
  async warmup(model: string, quick = true): Promise<void> {
    const url = new URL(`${this.config.apiBaseUrl}/chutes/warmup/${encodeURIComponent(model)}`);
    if (quick) url.searchParams.set("quick", "true");
    // Warmup is best-effort: never let a warmup hiccup block a generation.
    try {
      await this.getJson(url);
    } catch {
      /* ignore — the subsequent invoke surfaces real failures */
    }
  }

  /** Current compute-unit pricing table. Returned raw for the engine to read. */
  async pricing(): Promise<unknown> {
    return this.getJson(new URL(`${this.config.apiBaseUrl}/pricing`));
  }

  /** Invoke a cord on a chute's subdomain and return the raw response bytes. */
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(params.url, {
        method: params.method ?? "POST",
        headers: {
          Authorization: authHeaderValue(this.config),
          "Content-Type": "application/json",
          Accept: "*/*",
        },
        body: JSON.stringify(params.body),
        signal: params.signal,
      });
    } catch (err) {
      throw mapNetworkError(err, params.url);
    }
    if (!res.ok) throw await mapHttpError(res);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const cost = parseCostHeader(res.headers);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType, cost };
  }

  /** Download an asset referenced by a result URL (e.g. a CDN link). */
  async download(assetUrl: string): Promise<InvokeResult> {
    const headers: Record<string, string> = { Accept: "*/*" };
    if (isChutesHost(assetUrl)) headers.Authorization = authHeaderValue(this.config);
    let res: Response;
    try {
      res = await this.fetchImpl(assetUrl, {
        headers,
        signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
      });
    } catch (err) {
      throw mapNetworkError(err, assetUrl);
    }
    if (!res.ok) throw await mapHttpError(res);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType };
  }

  private async getJson(url: URL): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: authHeaderValue(this.config),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
      });
    } catch (err) {
      throw mapNetworkError(err, url.toString());
    }
    if (!res.ok) throw await mapHttpError(res);
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Response parsing (defensive: Chutes field names may vary across the catalog)
// ---------------------------------------------------------------------------

function extractArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (isObject(data)) {
    for (const key of ["items", "data", "chutes", "results"]) {
      const v = data[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function parseSummary(raw: Record<string, unknown>): ChuteSummary {
  const cords = parseCords(raw);
  const username = pickString(raw, "username") ?? pickString(asObject(raw.user), "username");
  const slug = pickString(raw, "slug");
  const name = pickString(raw, "name") ?? slug ?? pickString(raw, "chute_id") ?? "";
  const tagline = pickString(raw, "tagline");
  const template = pickString(raw, "standard_template") ?? pickString(raw, "template");
  return {
    id: pickString(raw, "chute_id") ?? pickString(raw, "id"),
    name,
    slug,
    username,
    tagline,
    template,
    kind: inferKind({ template, tagline, cords }),
  };
}

function parseDetail(data: unknown): ChuteDetail {
  const raw = isObject(data) ? data : {};
  const summary = parseSummary(raw);
  const cords = parseCords(raw);
  return {
    ...summary,
    cords,
    invokeBaseUrl: resolveInvokeBaseUrl(raw, summary),
    raw: data,
  };
}

function parseCords(raw: Record<string, unknown>): CordInfo[] {
  const list = raw.cords;
  if (!Array.isArray(list)) return [];
  return list
    .filter(isObject)
    .map((c): CordInfo => {
      const path = pickString(c, "public_api_path") ?? pickString(c, "path") ?? "/";
      const method = (
        pickString(c, "public_api_method") ??
        pickString(c, "method") ??
        "POST"
      ).toUpperCase();
      return {
        name: cordName(path, c),
        path: path.startsWith("/") ? path : `/${path}`,
        method,
        stream: c.stream === true,
        outputContentType: pickString(c, "output_content_type"),
        inputSchema: unwrapSchema(pickSchema(c)),
      };
    });
}

/**
 * Chutes cords built as `def f(self, x: Model)` expose a function-signature
 * schema ({ required:[x], properties:{x: Model} }) but accept the Model JSON
 * *flat* on the wire (FastAPI's single-body-model convention — see every media
 * example in the docs). When we detect that exact shape, unwrap to the inner
 * model so describe/validate/invoke all speak the same flat payload. The root's
 * definitions/$defs are carried along so nested $refs still resolve.
 */
function unwrapSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return schema;
  const top = derefLocal(schema, schema);
  const props = isObject(top.properties) ? (top.properties as Record<string, unknown>) : undefined;
  if (!props) return schema;
  const keys = Object.keys(props);
  if (keys.length !== 1) return schema;
  const inner = derefLocal(props[keys[0]!], schema);
  if (!isObject(inner.properties)) return schema; // single param isn't a model → leave as-is
  const out: JsonSchema = { ...inner };
  if (isObject(schema.definitions)) out.definitions = schema.definitions;
  if (isObject(schema.$defs)) out.$defs = schema.$defs;
  return out;
}

/** Resolve a local `#/definitions/...` / `#/$defs/...` $ref against the root schema. */
function derefLocal(node: unknown, root: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(node)) return {};
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let cur: unknown = root;
    for (const seg of ref.slice(2).split("/")) {
      if (!isObject(cur)) return node;
      cur = cur[seg];
    }
    if (isObject(cur)) return derefLocal(cur, root);
  }
  return node;
}

function cordName(path: string, c: Record<string, unknown>): string {
  const explicit = pickString(c, "name");
  if (explicit) return explicit;
  const trimmed = path.replace(/^\/+/, "");
  return trimmed || "generate";
}

function pickSchema(c: Record<string, unknown>): JsonSchema | undefined {
  for (const key of ["input_schema", "minimal_input_schema", "input"]) {
    const v = c[key];
    if (isObject(v)) return v;
  }
  const schema = asObject(c.schema);
  if (isObject(schema.input)) return schema.input;
  return undefined;
}

function resolveInvokeBaseUrl(
  raw: Record<string, unknown>,
  summary: ChuteSummary,
): string | undefined {
  const explicit =
    pickString(raw, "invocation_url") ??
    pickString(raw, "invoke_url") ??
    pickString(raw, "subdomain");
  if (explicit) return explicit.replace(/\/+$/, "");
  // Chutes' `slug` is the full subdomain label and already includes the owner
  // (e.g. "vonkaiser-qwen-image-2512"). Use it directly; only prepend the
  // username if the slug doesn't already start with it.
  const { username, slug } = summary;
  if (slug) {
    const label = username && !slug.startsWith(`${username}-`) ? `${username}-${slug}` : slug;
    return `https://${label}.chutes.ai`;
  }
  return undefined;
}

/** Best-effort media-kind inference for list filtering. */
export function inferKind(input: {
  template?: string;
  tagline?: string;
  cords: CordInfo[];
}): MediaKind | undefined {
  const cordText = input.cords
    .map((c) => `${c.path} ${c.outputContentType ?? ""}`)
    .join(" ");
  const text = `${input.template ?? ""} ${input.tagline ?? ""} ${cordText}`.toLowerCase();
  const outputs = input.cords.map((c) => c.outputContentType?.toLowerCase() ?? "");

  if (outputs.some((o) => o.startsWith("video/")) || /\bvideo\b|text2video|image2video/.test(text)) {
    return "video";
  }
  if (/\b(tts|text-to-speech|speech|voice|speak)\b/.test(text)) return "speech";
  if (/\b(music|song|melody|diffrhythm|ace-step)\b/.test(text)) return "music";
  if (outputs.some((o) => o.startsWith("image/")) || /\bimage\b|diffusion|flux|text2image|sdxl/.test(text)) {
    return "image";
  }
  // Audio output with no clearer signal: assume music over speech.
  if (outputs.some((o) => o.startsWith("audio/"))) return "music";
  return undefined;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function mapHttpError(res: Response): Promise<ChutesError> {
  const body = await safeReadBody(res);
  const detail = bodyMessage(body);
  switch (res.status) {
    case 401:
    case 403:
      return new ChutesError(`Unauthorized (${res.status})${detail}`, {
        status: res.status,
        body,
        hint: 'Check CHUTES_API_KEY. If it is set, try flipping CHUTES_AUTH_SCHEME between "raw" and "bearer".',
      });
    case 404:
      return new ChutesError(`Not found (404)${detail}`, {
        status: 404,
        body,
        hint: "Check the model name/slug — list models with list_media_models first.",
      });
    case 422:
      return new ChutesError(`Invalid request (422)${detail}`, {
        status: 422,
        body,
        hint: "The payload did not match the model schema. Re-check describe_media_model.",
      });
    case 429:
      return new ChutesError(`Rate limited (429)${detail}`, {
        status: 429,
        body,
        hint: "Slow down or retry after a short delay.",
      });
    default:
      if (res.status >= 500) {
        return new ChutesError(`Chutes server error (${res.status})${detail}`, {
          status: res.status,
          body,
          hint: "Transient — retry. If a cold start, warmup may still be in progress.",
        });
      }
      return new ChutesError(`Request failed (${res.status})${detail}`, { status: res.status, body });
  }
}

function mapNetworkError(err: unknown, url: string): ChutesError {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new ChutesError(`Request timed out: ${url}`, {
      hint: "Increase the per-call timeout, or warm the model up first.",
    });
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return new ChutesError(`Request aborted: ${url}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ChutesError(`Network error reaching ${url}: ${message}`);
}

async function safeReadBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function bodyMessage(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return `: ${truncate(body)}`;
  if (isObject(body)) {
    const msg = pickString(body, "detail") ?? pickString(body, "message") ?? pickString(body, "error");
    if (msg) return `: ${truncate(msg)}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Best-effort: some chutes expose the invocation cost via a response header. */
function parseCostHeader(headers: Headers): number | undefined {
  for (const name of ["x-chutes-cost", "x-cost", "x-compute-units", "x-chutes-compute-units"]) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isChutesHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("chutes.ai");
  } catch {
    return false;
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
