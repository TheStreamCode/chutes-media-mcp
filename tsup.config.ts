import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp/server.ts", "src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  splitting: false,
  // The bin entry files (mcp/server.ts, cli/index.ts) start with `#!/usr/bin/env node`;
  // esbuild preserves that shebang for entry points, so the built files are runnable.
});
