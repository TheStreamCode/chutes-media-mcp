/**
 * Shared, transport-agnostic types for the Chutes media core.
 * Nothing here knows about MCP or the CLI.
 */

export type MediaKind = "image" | "video" | "music" | "speech";

export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "music", "speech"];

/** A JSON Schema object as returned live by Chutes for a cord's input. */
export type JsonSchema = Record<string, unknown>;

/** How the API key is placed into the `Authorization` header. */
export type AuthScheme = "bearer" | "raw";

export interface ChutesConfig {
  /** Required. Read from CHUTES_API_KEY; never persisted to the repo. */
  apiKey: string;
  /** Management API base, e.g. https://api.chutes.ai */
  apiBaseUrl: string;
  /** `raw` sends the key as-is; `bearer` prefixes "Bearer ". */
  authScheme: AuthScheme;
  /** Default output directory (relative to CWD); kind subfolder is appended. */
  outputDir: string;
  /** Per-kind invocation timeout in milliseconds. */
  timeouts: Record<MediaKind, number>;
  /** Warm up a chute before invoking it. */
  warmup: boolean;
  /** Interval (ms) for emitting progress heartbeats while a call blocks. */
  progressIntervalMs: number;
  /** How many times to re-warm and retry when a cold model returns 503/no-instances. */
  coldStartRetries: number;
  /** Base backoff (ms) between cold-start retries (grows linearly per attempt). */
  coldStartBackoffMs: number;
  /** Reject params with fields not in the cord schema (renamed/unknown fields fail loudly). */
  strictParams: boolean;
  /** Write a provenance sidecar (<asset>.json) next to each generated asset. */
  writeProvenance: boolean;
}

/** One callable endpoint of a chute (e.g. /generate, /img2img, /speak). */
export interface CordInfo {
  /** Human label, derived from the path (e.g. "generate", "img2img"). */
  name: string;
  /** public_api_path, e.g. "/generate". */
  path: string;
  /** HTTP method, e.g. "POST". */
  method: string;
  /** Whether the cord streams its response (SSE). */
  stream: boolean;
  /** Declared output MIME type, e.g. "image/jpeg" / "video/mp4". */
  outputContentType?: string;
  /** Live JSON Schema for the cord's input, if exposed. */
  inputSchema?: JsonSchema;
}

export interface ChuteSummary {
  /** Stable id when present. */
  id?: string;
  /** Name used to address the chute in GET /chutes/{id_or_name}. */
  name: string;
  slug?: string;
  username?: string;
  tagline?: string;
  /** Standard template, e.g. "diffusion" / "tts" / "vllm". */
  template?: string;
  /** Best-effort media kind inferred from cords/template/tagline. */
  kind?: MediaKind;
}

export interface ChuteDetail extends ChuteSummary {
  /** All callable cords of this chute. */
  cords: CordInfo[];
  /** Per-chute invocation origin, e.g. https://user-slug.chutes.ai */
  invokeBaseUrl?: string;
  /** Original, unmodified response payload (so callers can inspect extras). */
  raw: unknown;
}

/** Raw result of invoking a cord: the returned asset bytes + its content type. */
export interface InvokeResult {
  bytes: Uint8Array;
  contentType: string;
  /** Best-effort per-invocation cost, if the response exposed it via a header. */
  cost?: number;
}

/** Progress event surfaced to whichever frontend is driving (MCP/CLI). */
export interface ProgressEvent {
  /** "warmup" | "submitting" | "waiting" | "downloading" | "saved". */
  stage: string;
  message: string;
  /** Monotonic 0..1 hint when known; omitted for indeterminate steps. */
  progress?: number;
  elapsedMs?: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/** Final result of a generation, returned by the engine to any frontend. */
export interface GenerateResult {
  path: string;
  kind: MediaKind;
  model: string;
  cord: string;
  bytes: number;
  contentType: string;
  cost?: number;
  durationMs: number;
  /** SHA-256 of the cord input schema used for this run (pins what was validated against). */
  schemaHash?: string;
  /** Path to the provenance sidecar written next to the asset, if enabled. */
  provenancePath?: string;
}
