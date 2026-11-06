// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "@effect/vitest";
import { proxyConfig } from "./proxy.ts";

it("uses only the explicitly selected ChatGPT profile and rejects incomplete auth", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "eval-codex-"));
  vi.stubEnv("T3_EVAL_CODEX_HOME", home);
  const auth = NodePath.join(home, "auth.json");
  try {
    NodeFS.writeFileSync(
      auth,
      JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }),
    );
    expect(proxyConfig()).toEqual({
      url: "https://chatgpt.com/backend-api/codex",
      headers: { Authorization: "Bearer test-token", "ChatGPT-Account-Id": "test-account" },
    });
    NodeFS.writeFileSync(
      auth,
      JSON.stringify({ tokens: { access_token: "private-incomplete-token" } }),
    );
    expect(() => proxyConfig()).toThrow(
      "Selected Codex profile requires an existing ChatGPT session",
    );
  } finally {
    vi.unstubAllEnvs();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
