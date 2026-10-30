#!/usr/bin/env node

// Protocol-level smoke test for the published MCP surface.
// It starts the built stdio server with a placeholder API key, performs the
// MCP handshake and validates the advertised tools. It never calls Chutes.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const expectedTools = ["list_media_models", "describe_media_model", "generate_media"];
const entrypoint = path.join(projectRoot, "dist", "mcp", "server.js");

const failures = [];
function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint],
  env: {
    ...childEnvironment,
    CHUTES_API_KEY: "cpk_smoke_test",
    CHUTES_API_BASE_URL: "https://chutes.ai",
  },
});

const client = new Client(
  { name: "chutes-media-mcp-smoke", version: "1.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);

  const serverVersion = client.getServerVersion();
  check(
    serverVersion?.name === "chutes-media-mcp",
    `server name is ${String(serverVersion?.name)}`,
  );
  check(
    serverVersion?.version === packageJson.version,
    `server version ${String(serverVersion?.version)} does not match package.json ${packageJson.version}`,
  );

  const instructions = client.getInstructions();
  check(
    typeof instructions === "string" && instructions.trim().length > 0,
    "initialize result has no instructions",
  );

  const firstList = await client.listTools();
  const secondList = await client.listTools();
  const tools = firstList.tools;

  check(
    tools.length === expectedTools.length,
    `expected ${expectedTools.length} tools, received ${tools.length}`,
  );
  check(
    JSON.stringify(firstList) === JSON.stringify(secondList),
    "tools/list is not deterministic across two calls",
  );

  const names = tools.map((tool) => tool.name).sort();
  check(
    JSON.stringify(names) === JSON.stringify([...expectedTools].sort()),
    `unexpected tool names: ${names.join(", ")}`,
  );

  const allToolNames = new Set();
  for (const tool of tools) {
    check(!allToolNames.has(tool.name), `${tool.name}: duplicate tool name`);
    allToolNames.add(tool.name);
    check(
      typeof tool.title === "string" && tool.title.trim().length > 0,
      `${tool.name}: missing title`,
    );
    check(
      typeof tool.description === "string" && tool.description.trim().length > 0,
      `${tool.name}: missing description`,
    );
    check(tool.inputSchema?.type === "object", `${tool.name}: inputSchema is not an object schema`);
    check(
      tool.outputSchema?.type === "object",
      `${tool.name}: outputSchema is not an object schema`,
    );
    check(
      typeof tool.annotations?.readOnlyHint === "boolean" &&
        typeof tool.annotations?.destructiveHint === "boolean" &&
        typeof tool.annotations?.idempotentHint === "boolean" &&
        typeof tool.annotations?.openWorldHint === "boolean",
      `${tool.name}: annotations are incomplete`,
    );
  }

  if (failures.length > 0) {
    console.error("MCP surface verification failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `MCP surface OK: ${tools.length} tools, version ${String(serverVersion?.version)}, ` +
        `${(instructions ?? "").length} instruction characters.`,
    );
  }
} catch (error) {
  console.error(
    `MCP surface verification could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
