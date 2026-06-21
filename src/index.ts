/**
 * Public entry point for the transport-agnostic core.
 * The MCP server, the CLI, and (later) the desktop fork all build on these.
 */
export * from "./core/types.js";
export { loadConfig, authHeaderValue, ConfigError } from "./core/config.js";
export { ChutesClient, ChutesError, inferKind } from "./core/chutes-client.js";
export type { FetchLike } from "./core/chutes-client.js";
export { MediaEngine, selectCord, resolveInputAssets, extensionFor } from "./core/media-engine.js";
export type { GenerateOptions } from "./core/media-engine.js";
export { validateParams } from "./core/schema-validate.js";
export type { ValidationResult } from "./core/schema-validate.js";
