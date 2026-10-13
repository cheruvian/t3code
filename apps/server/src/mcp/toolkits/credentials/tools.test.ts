import { describe, expect, it } from "vite-plus/test";
import { Tool } from "effect/ai";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { CredentialsToolkit } from "./tools.ts";
import { CredentialExecInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
describe("credential tool boundary", () => {
  it("rejects unsupported credential lifetimes before approval or delivery", () => {
    const decode = Schema.decodeUnknownSync(CredentialExecInput);
    const request = {
      site: "example.com",
      field: "login",
      label: "Sign in",
      reason: "Test credential access",
      argv: ["/usr/bin/consumer"],
    };
    for (const ttlSeconds of [4, 301, 900, 5.5])
      expect(() => decode({ ...request, ttlSeconds })).toThrow();
    for (const ttlSeconds of [5, 60, 300])
      expect(decode({ ...request, ttlSeconds }).ttlSeconds).toBe(ttlSeconds);
  });
  it("exposes only a site-based supervised execution request", () => {
    expect(Object.keys(CredentialsToolkit.tools)).toEqual(["credential_broker_exec"]);
    const schema = Tool.getJsonSchema(CredentialsToolkit.tools.credential_broker_exec);
    expect(schema).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(schema.properties).toHaveProperty("site");
    for (const operatorCapability of [
      "approve",
      "always",
      "item_id",
      "candidateId",
      "origin",
      "password",
      "token",
    ])
      expect(schema.properties).not.toHaveProperty(operatorCapability);
    expect(resolveT3McpToolDefinition("credential_broker_exec")).not.toBeNull();
  });
});
