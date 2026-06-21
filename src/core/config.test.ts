import { describe, expect, it } from "vitest";
import { authHeaderValue, ConfigError, loadConfig } from "./config.js";

const baseEnv = { CHUTES_API_KEY: "cpk_test_123" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("throws a ConfigError when CHUTES_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("trims the key and applies sensible defaults", () => {
    const cfg = loadConfig({ CHUTES_API_KEY: "  cpk_abc  " });
    expect(cfg.apiKey).toBe("cpk_abc");
    expect(cfg.apiBaseUrl).toBe("https://api.chutes.ai");
    expect(cfg.authScheme).toBe("raw");
    expect(cfg.outputDir).toBe("assets/chutes");
    expect(cfg.warmup).toBe(true);
    expect(cfg.timeouts.video).toBeGreaterThan(cfg.timeouts.image);
    expect(cfg.coldStartRetries).toBe(4);
    expect(cfg.coldStartBackoffMs).toBe(8000);
  });

  it("allows disabling cold-start retries with 0", () => {
    expect(loadConfig({ ...baseEnv, CHUTES_COLD_START_RETRIES: "0" }).coldStartRetries).toBe(0);
    expect(() => loadConfig({ ...baseEnv, CHUTES_COLD_START_RETRIES: "-1" })).toThrow(ConfigError);
  });

  it("strips a trailing slash from the base URL", () => {
    const cfg = loadConfig({ ...baseEnv, CHUTES_API_BASE_URL: "https://example.com/api/" });
    expect(cfg.apiBaseUrl).toBe("https://example.com/api");
  });

  it("honours CHUTES_AUTH_SCHEME and rejects invalid values", () => {
    expect(loadConfig({ ...baseEnv, CHUTES_AUTH_SCHEME: "bearer" }).authScheme).toBe("bearer");
    expect(() => loadConfig({ ...baseEnv, CHUTES_AUTH_SCHEME: "weird" })).toThrow(ConfigError);
  });

  it("disables warmup only on the literal string 'false'", () => {
    expect(loadConfig({ ...baseEnv, CHUTES_WARMUP: "false" }).warmup).toBe(false);
    expect(loadConfig({ ...baseEnv, CHUTES_WARMUP: "0" }).warmup).toBe(true);
  });

  it("validates CHUTES_PROGRESS_INTERVAL_MS", () => {
    expect(loadConfig({ ...baseEnv, CHUTES_PROGRESS_INTERVAL_MS: "2000" }).progressIntervalMs).toBe(2000);
    expect(() => loadConfig({ ...baseEnv, CHUTES_PROGRESS_INTERVAL_MS: "-5" })).toThrow(ConfigError);
  });
});

describe("authHeaderValue", () => {
  it("sends the raw key by default", () => {
    expect(authHeaderValue({ apiKey: "cpk_x", authScheme: "raw" })).toBe("cpk_x");
  });
  it("prefixes Bearer when configured", () => {
    expect(authHeaderValue({ apiKey: "cpk_x", authScheme: "bearer" })).toBe("Bearer cpk_x");
  });
});
