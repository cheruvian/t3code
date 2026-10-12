import { describe, expect, it } from "vite-plus/test";
import { Tool } from "effect/ai";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { CredentialsToolkit } from "./tools.ts";
describe("credential tool boundary", () => {
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
