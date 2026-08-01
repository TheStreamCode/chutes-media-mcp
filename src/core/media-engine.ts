import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChutesError } from "./chutes-client.js";
import type { ChutesClient } from "./chutes-client.js";
import { validateParams } from "./schema-validate.js";
import type {
  ChuteDetail,
  ChutesConfig,
  CordInfo,
  GenerateResult,
  InvokeResult,
  JsonSchema,
  MediaKind,
  ProgressCallback,
} from "./types.js";

export interface GenerateOptions {
  model: string;
  kind: MediaKind;
  params: Record<string, unknown>;
  /** Cord/operation name or path; defaults to the model's primary generation cord. */
  cord?: string;
  /** Output directory (relative to cwd unless absolute). Defaults to config.outputDir/<kind>. */
  outputDir?: string;
  /** Output filename; defaults to "<model>-<timestamp>.<ext>". */
  filename?: string;
  /** Explicitly allow replacing an existing asset and sidecar. Defaults to false. */
  overwrite?: boolean;
  /** Override the per-kind blocking timeout (ms). */
  timeoutMs?: number;
  /** Base for resolving relative input/output paths. Defaults to process.cwd(). */
  cwd?: string;
  /** External cancellation (e.g. an MCP client cancelling the request). */
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

const DESCRIBE_TTL_MS = 60_000;

/** Cords that edit existing media — never auto-selected as the primary operation. */
const EDIT_CORDS = new Set(["img2img", "inpaint", "image2image", "edit", "outpaint"]);

const PRIMARY_CORD_PREFS: Record<MediaKind, string[]> = {
  image: ["generate", "text2image", "txt2img", "t2i"],
  video: ["text2video", "txt2vid", "t2v", "generate"],
  music: ["generate", "text2music", "t2m"],
  speech: ["speak", "tts", "generate"],
};

const KIND_DEFAULT_CONTENT_TYPE: Record<MediaKind, string> = {
  image: "image/png",
  video: "video/mp4",
  music: "audio/mp3",
  speech: "audio/wav",
};

/** Param fields that carry text, never a file path to encode. */
const TEXT_FIELDS = new Set([
  "prompt",
  "negative_prompt",
  "text",
  "lyrics",
  "style_prompt",
  "system_prompt",
  "caption",
  "description",
]);

/**
 * Orchestrates the describe → validate → resolve → warmup → invoke → save flow.
 * Transport-agnostic: progress is surfaced via the injected callback so both the
 * MCP server and the CLI can render it.
 */
export class MediaEngine {
  private readonly client: ChutesClient;
  private readonly config: ChutesConfig;
  private readonly describeCache = new Map<string, { detail: ChuteDetail; expires: number }>();

  constructor(client: ChutesClient, config: ChutesConfig) {
    this.client = client;
    this.config = config;
  }

  list(params: Parameters<ChutesClient["list"]>[0] = {}) {
    return this.client.list(params);
  }

  /** Describe a model, memoised for a short TTL (shared by the describe tool). */
  async describe(model: string): Promise<ChuteDetail> {
    const cached = this.describeCache.get(model);
    if (cached && cached.expires > monotonicNow()) return cached.detail;
    const detail = await this.client.describe(model);
    this.describeCache.set(model, { detail, expires: monotonicNow() + DESCRIBE_TTL_MS });
    return detail;
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const startedAt = monotonicNow();
    const cwd = opts.cwd ?? process.cwd();
    const emit = opts.onProgress ?? (() => {});
    const workspaceRoot = path.resolve(cwd);
    const requestedDir = path.resolve(
      workspaceRoot,
      opts.outputDir ?? path.join(this.config.outputDir, opts.kind),
    );
    if (!isInsideWorkspace(requestedDir, workspaceRoot)) {
      throw new ChutesError("Output directory must stay inside the current workspace.");
    }
    const requestedFilename = opts.filename ? validateFilename(opts.filename) : undefined;

    emit({ stage: "describing", message: `Describing ${opts.model}` });
    const detail = await this.describe(opts.model);
    const cord = selectCord(detail, opts.kind, opts.cord);

    if (!detail.invokeBaseUrl) {
      throw new ChutesError(`Could not resolve an invocation URL for "${opts.model}".`, {
        hint: "The chute did not expose username/slug. Pass the full owner/slug name.",
      });
    }

    // 1. Validate before spending a GPU call.
    emit({ stage: "validating", message: `Validating params for cord "${cord.name}"` });
    const validation = validateParams(opts.params, cord.inputSchema, {
      strict: this.config.strictParams,
    });
    if (!validation.valid) {
      throw new ChutesError(
        `Invalid params for ${opts.model} (cord "${cord.name}"): ${validation.errors.join("; ")}`,
        { hint: "Call describe_media_model and fix the listed fields before retrying." },
      );
    }

    // 2. Resolve workspace file paths referenced in params (img2img/inpaint/etc.).
    const resolvedParams = await resolveInputAssets(
      opts.params,
      cwd,
      (msg) => emit({ stage: "resolving-assets", message: msg }),
      this.config.maxAssetBytes,
    );

    // Resolve the real paths before making a billable request. This catches
    // output directories that escape the workspace through a symlink/junction.
    const dir = await prepareOutputDirectory(workspaceRoot, requestedDir);
    const realWorkspaceRoot = await realpath(workspaceRoot);
    if (requestedFilename && !opts.overwrite) {
      const requestedPath = path.join(dir, requestedFilename);
      if (
        existsSync(requestedPath) ||
        (this.config.writeProvenance && existsSync(`${requestedPath}.json`))
      ) {
        throw new ChutesError(`Refusing to overwrite existing output "${requestedPath}".`, {
          hint: "Choose a new filename or pass overwrite=true explicitly.",
        });
      }
    } else if (requestedFilename) {
      const requestedPath = path.join(dir, requestedFilename);
      await assertSafeOverwriteTarget(requestedPath, realWorkspaceRoot);
      if (this.config.writeProvenance) {
        await assertSafeOverwriteTarget(`${requestedPath}.json`, realWorkspaceRoot);
      }
    }

    // 3. Warm up the (possibly cold) model.
    if (this.config.warmup) {
      emit({ stage: "warmup", message: "Warming up the model" });
      await this.client.warmup(opts.model);
    }

    // 4. Blocking invoke with progress heartbeats and cold-start retries.
    const url = `${detail.invokeBaseUrl}${cord.path}`;
    const timeoutMs = opts.timeoutMs ?? this.config.timeouts[opts.kind];
    const invokeResult = await this.invokeWithRetry(
      opts.model,
      url,
      cord,
      resolvedParams,
      timeoutMs,
      startedAt,
      emit,
      opts.signal,
    );

    // 5. Resolve the asset (raw bytes, or JSON carrying a URL / base64).
    const asset = await this.resolveAsset(invokeResult, opts.kind, emit);

    // 5b. Verify the returned asset actually matches the kind — a 200 with the
    // wrong media type means the call "succeeded" but produced the wrong thing.
    assertContentTypeMatchesKind(asset.contentType, opts.kind);

    // 6. Save into the workspace.
    const ext = extensionFor(asset.contentType, opts.kind);
    const filename = requestedFilename ?? `${sanitize(opts.model)}-${timestamp()}.${ext}`;
    const outPath = path.join(dir, filename);
    const provenancePath = this.config.writeProvenance ? `${outPath}.json` : undefined;
    if (
      !opts.overwrite &&
      (existsSync(outPath) || (provenancePath && existsSync(provenancePath)))
    ) {
      throw new ChutesError(`Refusing to overwrite existing output "${outPath}".`, {
        hint: "Choose a new filename or pass overwrite=true explicitly.",
      });
    }
    const writeFlag = opts.overwrite ? "w" : "wx";
    if (opts.overwrite) {
      await assertSafeOverwriteTarget(outPath, realWorkspaceRoot);
      if (provenancePath) await assertSafeOverwriteTarget(provenancePath, realWorkspaceRoot);
    }
    await writeFile(outPath, asset.bytes, { flag: writeFlag });
    emit({ stage: "saved", message: outPath, progress: 1 });

    // 7. Pin what produced this asset: hash the exact schema validated against,
    // and (optionally) write a provenance sidecar for reproducibility.
    const schemaHash = hashSchema(cord.inputSchema);
    const durationMs = monotonicNow() - startedAt;
    if (provenancePath) {
      const provenance = {
        asset: filename,
        kind: opts.kind,
        model: opts.model,
        cord: cord.name,
        invokeUrl: url,
        params: opts.params, // original input (paths, not the base64 we sent)
        seed: opts.params.seed,
        schemaHash,
        contentType: asset.contentType,
        bytes: asset.bytes.byteLength,
        cost: invokeResult.cost,
        durationMs,
        createdAt: new Date().toISOString(),
      };
      await writeFile(provenancePath, JSON.stringify(provenance, null, 2), { flag: writeFlag });
    }

    return {
      path: outPath,
      kind: opts.kind,
      model: opts.model,
      cord: cord.name,
      bytes: asset.bytes.byteLength,
      contentType: asset.contentType,
      cost: invokeResult.cost,
      durationMs,
      schemaHash,
      provenancePath,
    };
  }

  /**
   * Invoke a cord, retrying when a cold model returns 503/no-instances: re-warm,
   * back off, and try again up to config.coldStartRetries. Public chutes scaled
   * to zero often need a few attempts before an instance is ready.
   */
  private async invokeWithRetry(
    model: string,
    url: string,
    cord: CordInfo,
    body: Record<string, unknown>,
    timeoutMs: number,
    startedAt: number,
    emit: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<InvokeResult> {
    const maxRetries = this.config.coldStartRetries;
    for (let attempt = 0; ; attempt++) {
      emit({
        stage: "submitting",
        message: attempt === 0 ? `POST ${url}` : `Retrying POST ${url} (attempt ${attempt + 1})`,
      });
      try {
        return await this.invokeWithHeartbeat(url, cord, body, timeoutMs, startedAt, emit, signal);
      } catch (err) {
        if (attempt >= maxRetries || !isColdStartError(err)) throw err;
        const waitMs = this.config.coldStartBackoffMs * (attempt + 1);
        emit({
          stage: "cold-start",
          message: `Model is cold (no instances yet); re-warming and retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${maxRetries})`,
        });
        await this.client.warmup(model);
        await delay(waitMs, signal);
      }
    }
  }

  private async invokeWithHeartbeat(
    url: string,
    cord: CordInfo,
    body: Record<string, unknown>,
    timeoutMs: number,
    startedAt: number,
    emit: ProgressCallback,
    externalSignal?: AbortSignal,
  ): Promise<InvokeResult> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;
    const heartbeat = setInterval(() => {
      const elapsedMs = monotonicNow() - startedAt;
      emit({
        stage: "waiting",
        message: `Generating… ${Math.round(elapsedMs / 1000)}s`,
        elapsedMs,
        progress: Math.min(0.99, elapsedMs / timeoutMs),
      });
    }, this.config.progressIntervalMs);
    try {
      return await this.client.invoke({ url, method: cord.method, body, signal });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async resolveAsset(
    result: InvokeResult,
    kind: MediaKind,
    emit: ProgressCallback,
  ): Promise<InvokeResult> {
    if (!result.contentType.toLowerCase().startsWith("application/json")) return result;

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.bytes));
    } catch {
      throw new ChutesError("Model returned JSON that could not be parsed.", { body: undefined });
    }

    const candidate = findAssetString(parsed);
    if (!candidate) {
      throw new ChutesError(
        "Model returned JSON without a recognisable asset URL or base64 field.",
        {
          body: parsed,
          hint: "Inspect describe_media_model output; this cord may use a different shape.",
        },
      );
    }

    const dataUri = candidate.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataUri) {
      return { bytes: base64ToBytes(dataUri[2]!), contentType: dataUri[1]!, cost: result.cost };
    }
    if (/^https?:\/\//i.test(candidate)) {
      emit({ stage: "downloading", message: "Downloading result asset" });
      const downloaded = await this.client.download(candidate);
      return { ...downloaded, cost: result.cost ?? downloaded.cost };
    }
    // Otherwise treat it as raw base64.
    return {
      bytes: base64ToBytes(candidate),
      contentType: KIND_DEFAULT_CONTENT_TYPE[kind],
      cost: result.cost,
    };
  }
}

// ---------------------------------------------------------------------------
// Cord selection
// ---------------------------------------------------------------------------

export function selectCord(detail: ChuteDetail, kind: MediaKind, requested?: string): CordInfo {
  if (detail.cords.length === 0) {
    throw new ChutesError(`Model "${detail.name}" exposes no callable cords.`);
  }
  if (requested) {
    const norm = requested.replace(/^\/+/, "").toLowerCase();
    const found = detail.cords.find(
      (c) => c.name.toLowerCase() === norm || c.path.replace(/^\/+/, "").toLowerCase() === norm,
    );
    if (!found) {
      const available = detail.cords.map((c) => c.name).join(", ");
      throw new ChutesError(
        `Cord "${requested}" not found on "${detail.name}". Available: ${available}.`,
      );
    }
    return found;
  }

  for (const pref of PRIMARY_CORD_PREFS[kind]) {
    const match = detail.cords.find((c) => c.name.toLowerCase() === pref);
    if (match) return match;
  }
  const nonEdit = detail.cords.filter((c) => !EDIT_CORDS.has(c.name.toLowerCase()));
  const pool = nonEdit.length > 0 ? nonEdit : detail.cords;
  return pool.find((c) => c.method === "POST") ?? pool[0]!;
}

// ---------------------------------------------------------------------------
// Input asset resolution
// ---------------------------------------------------------------------------

/**
 * Replace any param value that points to an existing workspace file with its
 * base64 encoding. Text fields (prompt, lyrics, …) are never touched. This is
 * what lets an agent edit an image it generated moments earlier.
 */
export async function resolveInputAssets(
  params: Record<string, unknown>,
  cwd: string,
  note: (msg: string) => void,
  maxBytes = 512 * 1_024 * 1_024,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(params)) {
    if (TEXT_FIELDS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      const encoded = await maybeEncodeFile(value, cwd, maxBytes);
      if (encoded !== undefined) {
        out[key] = encoded;
        note(`Encoded ${key} from ${value}`);
      }
    } else if (Array.isArray(value)) {
      // Array fields like image_b64s: encode any element that is a workspace file.
      let changed = false;
      const values: unknown[] = value;
      const mapped = await Promise.all(
        values.map(async (v) => {
          const encoded =
            typeof v === "string" ? await maybeEncodeFile(v, cwd, maxBytes) : undefined;
          if (encoded !== undefined) {
            changed = true;
            return encoded;
          }
          return v;
        }),
      );
      if (changed) {
        out[key] = mapped;
        note(`Encoded ${key}[] from workspace files`);
      }
    }
  }
  return out;
}

/** Return base64 of a workspace file if `value` resolves to one, else undefined. */
async function maybeEncodeFile(
  value: string,
  cwd: string,
  maxBytes: number,
): Promise<string | undefined> {
  if (value.length > 1024 || value.includes("\n")) return undefined; // clearly not a path
  const workspaceRoot = path.resolve(cwd);
  const resolved = path.resolve(workspaceRoot, value);
  if (!isInsideWorkspace(resolved, workspaceRoot) || !existsSync(resolved)) return undefined;

  let realWorkspaceRoot: string;
  let realFile: string;
  try {
    [realWorkspaceRoot, realFile] = await Promise.all([
      realpath(workspaceRoot),
      realpath(resolved),
    ]);
  } catch {
    return undefined;
  }
  if (!isInsideWorkspace(realFile, realWorkspaceRoot)) return undefined;
  const metadata = await stat(realFile);
  if (!metadata.isFile()) return undefined;
  if (metadata.size > maxBytes) {
    throw new ChutesError(`Input asset exceeds the configured ${maxBytes}-byte asset limit.`);
  }
  const bytes = await readFile(realFile);
  return bytes.toString("base64");
}

/**
 * True when `resolved` is `root` itself or lives under it. Params reach this
 * code straight from the model, so an absolute path or a `../` escape would
 * otherwise read any file on the machine and upload it to a third-party chute.
 */
export function isInsideWorkspace(resolved: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function prepareOutputDirectory(
  workspaceRoot: string,
  requestedDir: string,
): Promise<string> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  let existingAncestor = requestedDir;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new ChutesError("Could not resolve a safe output directory.");
    }
    existingAncestor = parent;
  }
  const realAncestor = await realpath(existingAncestor);
  if (!isInsideWorkspace(realAncestor, realWorkspaceRoot)) {
    throw new ChutesError("Output directory resolves outside the current workspace.");
  }

  await mkdir(requestedDir, { recursive: true });
  const realDirectory = await realpath(requestedDir);
  if (!isInsideWorkspace(realDirectory, realWorkspaceRoot)) {
    throw new ChutesError("Output directory resolves outside the current workspace.");
  }
  return realDirectory;
}

async function assertSafeOverwriteTarget(target: string, workspaceRoot: string): Promise<void> {
  if (!existsSync(target)) return;
  const metadata = await lstat(target);
  const resolved = await realpath(target);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink > 1 ||
    !isInsideWorkspace(resolved, workspaceRoot)
  ) {
    throw new ChutesError(`Refusing to overwrite unsafe output target "${target}".`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSET_KEYS = [
  "url",
  "image_url",
  "video_url",
  "audio_url",
  "result_url",
  "output_url",
  "b64_json",
  "base64",
  "image",
  "video",
  "audio",
  "output",
  "result",
  "data",
];

/** Find the first plausible asset string (URL/base64/data-URI) in a JSON body. */
function findAssetString(obj: unknown): string | undefined {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findAssetString(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of ASSET_KEYS) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const nested = findAssetString(v);
      if (nested) return nested;
    }
  }
  return undefined;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

const FALLBACK_EXT: Record<MediaKind, string> = {
  image: "png",
  video: "mp4",
  music: "mp3",
  speech: "wav",
};

export function extensionFor(contentType: string, kind: MediaKind): string {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  const knownExtension = EXT_BY_CONTENT_TYPE[ct];
  if (knownExtension) return knownExtension;
  const sub = ct.split("/")[1];
  if (sub && /^[a-z0-9]+$/.test(sub)) return sub;
  return FALLBACK_EXT[kind];
}

const KIND_CONTENT_FAMILY: Record<MediaKind, string> = {
  image: "image/",
  video: "video/",
  music: "audio/",
  speech: "audio/",
};

/** Throw if the returned media type clearly contradicts the requested kind. */
export function assertContentTypeMatchesKind(contentType: string, kind: MediaKind): void {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct === "" || ct.endsWith("/octet-stream")) return; // opaque — can't tell
  if (!ct.startsWith(KIND_CONTENT_FAMILY[kind])) {
    throw new ChutesError(
      `Model returned ${ct}, which doesn't match the requested kind "${kind}".`,
      {
        hint: "The cord may produce a different media type than expected — re-check describe_media_model.",
      },
    );
  }
}

/** Stable SHA-256 fingerprint of a schema, so a provider-side change is detectable. */
export function hashSchema(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined;
  return createHash("sha256").update(stableStringify(schema)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new ChutesError("Model returned malformed base64 asset data.");
  }
  const bytes = Buffer.from(normalized, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized.replace(/=+$/, "")) {
    throw new ChutesError("Model returned malformed base64 asset data.");
  }
  return new Uint8Array(bytes);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function validateFilename(filename: string): string {
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename !== path.basename(filename) ||
    /[<>:"/\\|?*]/.test(filename) ||
    hasControlCharacter(filename) ||
    /[. ]$/.test(filename) ||
    Buffer.byteLength(filename, "utf8") > 255
  ) {
    throw new ChutesError("filename must be a valid single file name without path separators.");
  }
  const dot = filename.indexOf(".");
  const stem = filename.slice(0, dot === -1 ? filename.length : dot).toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new ChutesError(`filename "${filename}" is reserved on Windows.`);
  }
  return filename;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function monotonicNow(): number {
  return Math.round(performance.now());
}

/** True for the transient cold-start condition worth retrying. */
function isColdStartError(err: unknown): boolean {
  if (!(err instanceof ChutesError)) return false;
  if (err.status === 503) return true;
  return (
    typeof err.status === "number" &&
    err.status >= 500 &&
    /no instances|instance|cold|capacity|not ready/i.test(err.message)
  );
}

/** Cancellable delay that rejects if the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ChutesError("Aborted while waiting to retry."));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ChutesError("Aborted while waiting to retry."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
