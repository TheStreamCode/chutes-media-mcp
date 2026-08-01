import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** DNS resolver shape kept injectable so SSRF checks remain deterministic in tests. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

const resolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

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
const MAX_ASSET_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ChutesClient {
  private readonly config: ChutesConfig;
  private readonly fetchImpl: FetchLike;
  private readonly resolveHost: ResolveHost;

  constructor(
    config: ChutesConfig,
    fetchImpl: FetchLike = globalThis.fetch,
    resolver: ResolveHost = resolveHost,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.resolveHost = resolver;
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
    if (!isSecureChutesUrl(params.url)) {
      throw new ChutesError("Refusing to send the Chutes API key to an untrusted invocation URL.", {
        hint: "Invocation URLs must use HTTPS on chutes.ai or one of its subdomains.",
      });
    }
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
        redirect: "error",
      });
    } catch (err) {
      throw mapNetworkError(err, params.url);
    }
    if (!res.ok) throw await mapHttpError(res);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const cost = parseCostHeader(res.headers);
    const bytes = await readResponseBytes(res, this.config.maxAssetBytes);
    return { bytes, contentType, cost };
  }

  /** Download an asset referenced by a result URL (e.g. a CDN link). */
  async download(assetUrl: string): Promise<InvokeResult> {
    const signal = AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS);
    let currentUrl = assetUrl;

    for (let redirects = 0; redirects <= MAX_ASSET_REDIRECTS; redirects++) {
      const parsed = parseSafeAssetUrl(currentUrl);
      await this.assertPublicAssetDestination(parsed);
      const headers: Record<string, string> = { Accept: "*/*" };
      if (isSecureChutesUrl(parsed.toString())) {
        headers.Authorization = authHeaderValue(this.config);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(parsed, {
          headers,
          signal,
          redirect: "manual",
        });
      } catch (err) {
        throw mapNetworkError(err, parsed.toString());
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw await mapHttpError(res);
        if (redirects === MAX_ASSET_REDIRECTS) {
          throw new ChutesError(`Asset download exceeded ${MAX_ASSET_REDIRECTS} redirects.`);
        }
        currentUrl = new URL(location, parsed).toString();
        continue;
      }

      if (!res.ok) throw await mapHttpError(res);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const bytes = await readResponseBytes(res, this.config.maxAssetBytes);
      return { bytes, contentType };
    }

    throw new ChutesError("Asset download failed after redirect validation.");
  }

  private async assertPublicAssetDestination(url: URL): Promise<void> {
    if (isChutesHost(url.toString()) || isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return;
    let addresses: readonly string[];
    try {
      addresses = await this.resolveHost(url.hostname);
    } catch {
      throw new ChutesError(`Could not resolve asset host "${url.hostname}".`);
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
      throw new ChutesError("Refusing to download an asset from a non-public network address.");
    }
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
        redirect: "error",
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
  return list.filter(isObject).map((c): CordInfo => {
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
  const props = isObject(top.properties) ? top.properties : undefined;
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
function derefLocal(
  node: unknown,
  root: Record<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (!isObject(node)) return {};
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.has(ref)) return node;
    let cur: unknown = root;
    for (const seg of ref.slice(2).split("/")) {
      if (!isObject(cur)) return node;
      cur = cur[seg];
    }
    if (isObject(cur)) return derefLocal(cur, root, new Set([...seen, ref]));
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
  const explicit = pickString(raw, "invocation_url") ?? pickString(raw, "invoke_url");
  if (explicit) return explicit.replace(/\/+$/, "");
  const subdomain = pickString(raw, "subdomain");
  if (subdomain) {
    if (/^https?:\/\//i.test(subdomain)) return subdomain.replace(/\/+$/, "");
    const label = subdomain.replace(/^\.+|\.+$/g, "");
    if (label) return `https://${label}.chutes.ai`;
  }
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
  const cordText = input.cords.map((c) => `${c.path} ${c.outputContentType ?? ""}`).join(" ");
  const text = `${input.template ?? ""} ${input.tagline ?? ""} ${cordText}`.toLowerCase();
  const outputs = input.cords.map((c) => c.outputContentType?.toLowerCase() ?? "");

  if (
    outputs.some((o) => o.startsWith("video/")) ||
    /\bvideo\b|text2video|image2video/.test(text)
  ) {
    return "video";
  }
  if (/\b(tts|text-to-speech|speech|voice|speak)\b/.test(text)) return "speech";
  if (/\b(music|song|melody|diffrhythm|ace-step)\b/.test(text)) return "music";
  if (
    outputs.some((o) => o.startsWith("image/")) ||
    /\bimage\b|diffusion|flux|text2image|sdxl/.test(text)
  ) {
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
      return new ChutesError(`Request failed (${res.status})${detail}`, {
        status: res.status,
        body,
      });
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
    const msg =
      pickString(body, "detail") ?? pickString(body, "message") ?? pickString(body, "error");
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

export function isChutesHost(url: string): boolean {
  try {
    // Must match the apex host or a real subdomain of it. A bare `endsWith`
    // would also accept lookalike domains such as `evilchutes.ai`, which would
    // leak the API key to whoever registered them.
    const host = new URL(url).hostname.toLowerCase();
    return host === "chutes.ai" || host.endsWith(".chutes.ai");
  } catch {
    return false;
  }
}

/** True only for credential-bearing Chutes URLs protected by TLS. */
export function isSecureChutesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      isChutesHost(parsed.toString())
    );
  } catch {
    return false;
  }
}

/**
 * Asset URLs come from a remote model. Require TLS and reject explicit local,
 * private, link-local, and otherwise non-routable destinations to limit SSRF.
 */
export function isSafeAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local")
    ) {
      return false;
    }
    const version = isIP(hostname);
    if (version === 4) return isPublicIpv4(hostname);
    if (version === 6) return isPublicIpv6(hostname);
    return hostname.length > 0;
  } catch {
    return false;
  }
}

function parseSafeAssetUrl(url: string): URL {
  if (!isSafeAssetUrl(url)) {
    throw new ChutesError("Refusing to download an asset from an unsafe URL.", {
      hint: "Asset URLs must use HTTPS and resolve to a public destination.",
    });
  }
  return new URL(url);
}

function isPublicIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "::" || value === "::1") return false;
  if (value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return false;
  if (value.startsWith("ff")) return false;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return true;
}

function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function readResponseBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ChutesError(`Response exceeds the configured ${maxBytes}-byte asset limit.`);
  }
  if (!res.body) return new Uint8Array();

  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ChutesError(`Response exceeds the configured ${maxBytes}-byte asset limit.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
