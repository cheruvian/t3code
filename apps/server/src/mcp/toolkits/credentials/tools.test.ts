import { describe, expect, it } from "vite-plus/test";
import { Tool } from "effect/ai";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { CredentialsToolkit } from "./tools.ts";
import { CredentialExecInput, CredentialBrokerAction } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const decode = Schema.decodeUnknownSync(CredentialExecInput);
const decodeAction = Schema.decodeUnknownSync(CredentialBrokerAction);

describe("credential tool boundary", () => {
  it("rejects unsupported credential lifetimes before approval or delivery", () => {
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
  it("accepts SSH-key requests while keeping key material out of the tool input", () => {
    const input = {
      site: "tower.example.com",
      field: "sshKey",
      label: "SSH access",
      reason: "Existing SSH authentication failed",
      ttlSeconds: 60,
      argv: ["node", "/tmp/ssh-consumer.mjs"],
    };
    expect(decode(input).field).toBe("sshKey");
    expect(decode({ ...input, field: "ssh" }).field).toBe("ssh");
  });
  it("supports browsing, searching and resetting only through operator actions", () => {
    const request = { type: "search", requestId: "test-request" };
    expect(decodeAction(request)).toEqual(request);
    for (const query of ["", "heihei", "x".repeat(200)])
      expect(decodeAction({ ...request, query })).toEqual({ ...request, query });
    expect(() => decodeAction({ ...request, query: "x".repeat(201) })).toThrow();
  });
  it("exposes requests without human approval or secret entry capabilities", () => {
    expect(Object.keys(CredentialsToolkit.tools)).toEqual(["credential_broker_exec"]);
    expect(resolveT3McpToolDefinition("preview_login")).toBeNull();
    const schema = Tool.getJsonSchema(CredentialsToolkit.tools.credential_broker_exec);
    expect(schema).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(schema.properties).toHaveProperty("site");
    for (const operatorCapability of [
      "approve",
      "always",
      "item_id",
      "candidateId",
      "query",
      "allowHostMismatch",
      "origin",
      "password",
      "token",
    ])
      expect(schema.properties).not.toHaveProperty(operatorCapability);
    expect(resolveT3McpToolDefinition("credential_broker_exec")).not.toBeNull();
  });
});
