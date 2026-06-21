import type { AuthScheme, ChutesConfig, MediaKind } from "./types.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_API_BASE_URL = "https://api.chutes.ai";
const DEFAULT_OUTPUT_DIR = "assets/chutes";
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;
const DEFAULT_COLD_START_RETRIES = 4;
const DEFAULT_COLD_START_BACKOFF_MS = 8_000;

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
  throw new ConfigError(
    `Invalid CHUTES_AUTH_SCHEME "${value}". Use "raw" (default) or "bearer".`,
  );
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

  return {
    apiKey,
    apiBaseUrl: (env.CHUTES_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    authScheme: parseAuthScheme(env.CHUTES_AUTH_SCHEME),
    outputDir: env.CHUTES_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
    timeouts: { ...DEFAULT_TIMEOUTS },
    warmup: env.CHUTES_WARMUP?.toLowerCase() !== "false",
    progressIntervalMs,
    coldStartRetries,
    coldStartBackoffMs,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Invalid ${name} "${value}". Expected a positive integer.`);
  }
  return n;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`Invalid ${name} "${value}". Expected a non-negative integer.`);
  }
  return n;
}

/** Build the `Authorization` header value for the configured scheme. */
export function authHeaderValue(config: Pick<ChutesConfig, "apiKey" | "authScheme">): string {
  return config.authScheme === "bearer" ? `Bearer ${config.apiKey}` : config.apiKey;
}
