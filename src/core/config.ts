import type { AuthScheme, ChutesConfig, MediaKind } from "./types.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_API_BASE_URL = "https://api.chutes.ai";
const DEFAULT_OUTPUT_DIR = "assets/chutes";
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;
const DEFAULT_COLD_START_RETRIES = 4;
const DEFAULT_COLD_START_BACKOFF_MS = 8_000;
const DEFAULT_MAX_ASSET_MB = 512;

/** Generous, kind-specific blocking timeouts (Chutes media cords are synchronous). */
const DEFAULT_TIMEOUTS: Record<MediaKind, number> = {
  image: 120_000,
  speech: 120_000,
  video: 600_000,
  music: 600_000,
};

function parseAuthScheme(value: string | undefined): AuthScheme {
  if (value === undefined || value === "") return "raw";
  const v = value.toLowerCase();
  if (v === "raw" || v === "bearer") return v;
  throw new ConfigError(`Invalid CHUTES_AUTH_SCHEME "${value}". Use "raw" (default) or "bearer".`);
}

function parseApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`Invalid CHUTES_API_BASE_URL "${raw}". Expected an absolute HTTPS URL.`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback.has(parsed.hostname))) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ConfigError(
      "CHUTES_API_BASE_URL must use HTTPS (HTTP is allowed only for loopback development) and contain no credentials, query, or fragment.",
    );
  }
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 47) end--;
  return raw.slice(0, end);
}

/**
 * Resolve runtime config from the environment.
 *
 * Only CHUTES_API_KEY is required. The key is read from the environment and is
 * never written back to disk.
 *
 * Optional overrides:
 *   CHUTES_API_BASE_URL   default https://api.chutes.ai
 *   CHUTES_AUTH_SCHEME    "raw" (default) | "bearer" — how to send the key
 *   CHUTES_OUTPUT_DIR     default assets/chutes (relative to CWD)
 *   CHUTES_PROGRESS_INTERVAL_MS  default 5000
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ChutesConfig {
  const apiKey = env.CHUTES_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "CHUTES_API_KEY is not set. Export your Chutes API key, e.g.\n" +
        '  PowerShell:  $env:CHUTES_API_KEY = "cpk_..."\n' +
        '  bash:        export CHUTES_API_KEY="cpk_..."',
    );
  }

  const progressIntervalMs = parsePositiveInt(
    env.CHUTES_PROGRESS_INTERVAL_MS,
    DEFAULT_PROGRESS_INTERVAL_MS,
    "CHUTES_PROGRESS_INTERVAL_MS",
  );
  const coldStartRetries = parseNonNegativeInt(
    env.CHUTES_COLD_START_RETRIES,
    DEFAULT_COLD_START_RETRIES,
    "CHUTES_COLD_START_RETRIES",
  );
  const coldStartBackoffMs = parsePositiveInt(
    env.CHUTES_COLD_START_BACKOFF_MS,
    DEFAULT_COLD_START_BACKOFF_MS,
    "CHUTES_COLD_START_BACKOFF_MS",
  );
  const maxAssetMb = parsePositiveInt(
    env.CHUTES_MAX_ASSET_MB,
    DEFAULT_MAX_ASSET_MB,
    "CHUTES_MAX_ASSET_MB",
  );
  if (maxAssetMb > 4_096) {
    throw new ConfigError('Invalid CHUTES_MAX_ASSET_MB. The maximum supported value is "4096".');
  }

  return {
    apiKey,
    apiBaseUrl: parseApiBaseUrl(env.CHUTES_API_BASE_URL),
    authScheme: parseAuthScheme(env.CHUTES_AUTH_SCHEME),
    outputDir: env.CHUTES_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
    timeouts: { ...DEFAULT_TIMEOUTS },
    warmup: env.CHUTES_WARMUP?.toLowerCase() !== "false",
    progressIntervalMs,
    coldStartRetries,
    coldStartBackoffMs,
    maxAssetBytes: maxAssetMb * 1_024 * 1_024,
    strictParams: env.CHUTES_ALLOW_UNKNOWN_PARAMS?.toLowerCase() !== "true",
    writeProvenance: env.CHUTES_PROVENANCE?.toLowerCase() !== "false",
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(`Invalid ${name} "${value}". Expected a positive integer.`);
  }
  return n;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ConfigError(`Invalid ${name} "${value}". Expected a non-negative integer.`);
  }
  return n;
}

/** Build the `Authorization` header value for the configured scheme. */
export function authHeaderValue(config: Pick<ChutesConfig, "apiKey" | "authScheme">): string {
  return config.authScheme === "bearer" ? `Bearer ${config.apiKey}` : config.apiKey;
}
