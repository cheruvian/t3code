// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the consumer HTTP transport and supervised Node process with fake credentials.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { T3CredentialBroker } from "@t3tools/credential-broker";
import { createBrowserScriptBridge } from "./BrowserScriptBridge.ts";

const DEMO_ITEM = "11111111-1111-4111-8111-111111111111";
const DEMO_PASSWORD = "fake-consumer-password";
const provider = {
  mode: "demo",
  initialize: async () => {},
  close: async () => {},
  search: async (site: string) => [{ item_id: DEMO_ITEM, name: "Fake login", hosts: [site] }],
  get: async () => JSON.stringify({ username: "fake@example.com", password: DEMO_PASSWORD }),
};

function pageFixture() {
  const fields = new Map<string, string>();
  let submitted = false;
  let passwordStep = false;
  const page = {
    url: () => "https://example.com/login",
    isClosed: () => false,
    locator: (selector: string) => ({
      fill: async (value: string) => {
        if (selector === "#password" && !passwordStep)
          throw new Error("Password step is not visible");
        fields.set(selector, value);
      },
      click: async () => {
        if (selector === "#next") passwordStep = fields.has("#username");
        else submitted = passwordStep && fields.has("#password");
      },
      waitFor: async () => {
        if (selector === "#password" && !passwordStep)
          throw new Error("Password step is not visible");
      },
      isVisible: async () => selector === "#signed-in" && submitted,
    }),
  };
  return { page: page as unknown as Page, fields, submitted: () => submitted };
}

describe("approved script access to the existing browser page", () => {
  it("delivers a real temporary credential file to a script that fills and submits the original page", async () => {
    const fixture = pageFixture();
    const runtime = await NodeFSP.mkdtemp("/tmp/t3-browser-script-");
    const bridge = await createBrowserScriptBridge({
      page: fixture.page,
      run: (action) => action(),
    });
    const broker = new T3CredentialBroker({ runtime });
    Object.assign(broker, { provider, watchdog: false });
    const endpoint = bridge.endpoint;
    try {
      await broker.action("human", { type: "unlock", password: "fake-master-unused" });
      const script = NodePath.join(runtime, "consumer.mjs");
      const receipt = NodePath.join(runtime, "receipt.json");
      await NodeFSP.writeFile(
        script,
        `
        import fs from 'node:fs';
        const login = JSON.parse(fs.readFileSync(process.env.CB_CREDENTIAL_FILE, 'utf8'));
        async function act(command) {
          const response = await fetch(process.env.T3_BROWSER_URL, {
            method: 'POST', body: JSON.stringify(command),
          });
          if (!response.ok) process.exit(1);
          return (await response.json()).result;
        }
        await act({operation:'fill',selector:'#username',value:login.username});
        await act({operation:'click',selector:'#next'});
        await act({operation:'waitFor',selector:'#password'});
        await act({operation:'fill',selector:'#password',value:login.password});
        await act({operation:'click',selector:'#submit'});
        const signedIn = await act({operation:'isVisible',selector:'#signed-in'});
        fs.writeFileSync(process.argv[2],JSON.stringify({signedIn}));
      `,
      );
      const caller = {
        environmentId: EnvironmentId.make("environment:test"),
        threadId: ThreadId.make("thread:test"),
        threadTitle: "Browser script test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session:test",
        runId: "run:test",
        toolCallId: "call:test",
        workspace: runtime,
        agent: "test",
      };
      let requestReady!: (id: string) => void;
      const pending = new Promise<string>((resolve) => {
        requestReady = resolve;
      });
      const unsubscribe = broker.subscribe("human", "test", (state) => {
        const request = state.requests.find((item) => item.state === "pending");
        if (request) requestReady(request.requestId);
      });
      try {
        const execution = broker.execute(
          caller,
          {
            site: "example.com",
            field: "login",
            label: "Use saved password",
            reason: "Test same-tab sign-in",
            ttlSeconds: 30,
            argv: [process.execPath, script, receipt],
            cwd: runtime,
          },
          undefined,
          { T3_BROWSER_URL: bridge.endpoint },
        );
        const requestId = await pending;
        expect(fixture.fields.size).toBe(0);
        expect(JSON.stringify(broker.state())).not.toContain(endpoint);
        await broker.action("human", {
          type: "decide",
          requestId,
          decision: "once",
          candidateId: DEMO_ITEM,
        });
        const result = await execution;
        expect(result).toMatchObject({ state: "completed", exitCode: 0 });
        expect(fixture.fields.get("#password")).toBe(DEMO_PASSWORD);
        expect(fixture.submitted()).toBe(true);
        expect(JSON.parse(await NodeFSP.readFile(receipt, "utf8"))).toEqual({ signedIn: true });
        expect(await NodeFSP.readdir(NodePath.join(runtime, "leases"))).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(DEMO_PASSWORD);
      } finally {
        unsubscribe();
      }
    } finally {
      await broker.close();
      await bridge.close();
      await NodeFSP.rm(runtime, { recursive: true, force: true });
    }
    await expect(
      fetch(endpoint, { method: "POST", body: JSON.stringify({ operation: "url" }) }),
    ).rejects.toThrow();
  });

  it("withholds raw browser errors and rejects page-origin and malformed requests", async () => {
    const fixture = pageFixture();
    const run = vi.fn(async () => {
      throw new Error("fake-password-in-browser-error");
    });
    const bridge = await createBrowserScriptBridge({ page: fixture.page, run });
    try {
      const failed = await fetch(bridge.endpoint, {
        method: "POST",
        body: JSON.stringify({ operation: "click", selector: "button" }),
      });
      expect(await failed.json()).toEqual({ error: "browser_action_failed" });
      const count = run.mock.calls.length;
      expect(
        (
          await fetch(bridge.endpoint, {
            method: "POST",
            headers: { origin: "https://example.com" },
            body: JSON.stringify({ operation: "url" }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(bridge.endpoint, {
            method: "POST",
            body: JSON.stringify({ operation: "unknown" }),
          })
        ).status,
      ).toBe(400);
      expect(run.mock.calls).toHaveLength(count);
    } finally {
      await bridge.close();
    }
  });
});
