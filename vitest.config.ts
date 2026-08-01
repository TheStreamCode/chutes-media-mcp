import { defineConfig } from "vitest/config";

export default defineConfig({
  // The real project lives under a path containing "#", which breaks Vite's
  // URL-based module resolution. Tests are run via a junction at a clean path;
  // preserveSymlinks keeps Vite on that clean path instead of realpath-ing back
  // to the "#" directory. (No effect when the project sits at a normal path.)
  resolve: { preserveSymlinks: true },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/core/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
