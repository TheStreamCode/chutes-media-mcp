import { describe, expect, it } from "vitest";
import path from "node:path";
import { isChutesHost, isSafeAssetUrl, isSecureChutesUrl } from "../src/core/chutes-client.js";
import { isInsideWorkspace } from "../src/core/media-engine.js";

// Both helpers gate data that leaves the machine: `isChutesHost` decides whether
// the API key is attached to a request, `isInsideWorkspace` decides whether a
// file is read and uploaded. The asset URL and the params they run on both come
// straight out of a third-party chute's response, so a permissive match here is
// a credential leak or an arbitrary file read.

describe("isChutesHost", () => {
  it("accepts the apex host and real subdomains", () => {
    expect(isChutesHost("https://chutes.ai/asset.png")).toBe(true);
    expect(isChutesHost("https://cdn.chutes.ai/asset.png")).toBe(true);
    expect(isChutesHost("https://a.b.chutes.ai/asset.png")).toBe(true);
    expect(isChutesHost("https://CHUTES.AI/asset.png")).toBe(true);
  });

  it("rejects lookalike domains that merely end with the string", () => {
    // Regression: a bare `hostname.endsWith("chutes.ai")` accepted all of these
    // and sent the Authorization header to whoever owned them.
    expect(isChutesHost("https://evilchutes.ai/x")).toBe(false);
    expect(isChutesHost("https://notchutes.ai/x")).toBe(false);
    expect(isChutesHost("https://chutes.ai.attacker.com/x")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isChutesHost("not a url")).toBe(false);
    expect(isChutesHost("")).toBe(false);
  });
});

describe("isSecureChutesUrl", () => {
  it("requires HTTPS without embedded credentials", () => {
    expect(isSecureChutesUrl("https://model.chutes.ai/generate")).toBe(true);
    expect(isSecureChutesUrl("http://model.chutes.ai/generate")).toBe(false);
    expect(isSecureChutesUrl("https://user:pass@model.chutes.ai/generate")).toBe(false);
    expect(isSecureChutesUrl("https://attacker.example/generate")).toBe(false);
  });
});

describe("isSafeAssetUrl", () => {
  it("accepts public HTTPS URLs", () => {
    expect(isSafeAssetUrl("https://cdn.chutes.ai/asset.png")).toBe(true);
    expect(isSafeAssetUrl("https://8.8.8.8/asset.png")).toBe(true);
  });

  it("rejects cleartext, credentials, localhost, and private IP ranges", () => {
    expect(isSafeAssetUrl("http://cdn.chutes.ai/asset.png")).toBe(false);
    expect(isSafeAssetUrl("https://user:pass@example.com/asset.png")).toBe(false);
    expect(isSafeAssetUrl("https://localhost/asset.png")).toBe(false);
    expect(isSafeAssetUrl("https://127.0.0.1/asset.png")).toBe(false);
    expect(isSafeAssetUrl("https://10.0.0.1/asset.png")).toBe(false);
    expect(isSafeAssetUrl("https://[::1]/asset.png")).toBe(false);
  });
});

describe("isInsideWorkspace", () => {
  const root = path.resolve("/tmp/workspace");

  it("accepts the root itself and paths under it", () => {
    expect(isInsideWorkspace(root, root)).toBe(true);
    expect(isInsideWorkspace(path.join(root, "img.png"), root)).toBe(true);
    expect(isInsideWorkspace(path.join(root, "nested", "img.png"), root)).toBe(true);
  });

  it("rejects traversal and absolute paths outside the root", () => {
    expect(isInsideWorkspace(path.resolve(root, "../secret.txt"), root)).toBe(false);
    expect(isInsideWorkspace(path.resolve(root, "../../.ssh/id_rsa"), root)).toBe(false);
    expect(isInsideWorkspace(path.resolve("/etc/passwd"), root)).toBe(false);
  });

  it("rejects a sibling directory sharing the root's prefix", () => {
    expect(isInsideWorkspace(path.resolve("/tmp/workspace-evil/x"), root)).toBe(false);
  });
});
