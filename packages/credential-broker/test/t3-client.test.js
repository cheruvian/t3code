import test from "node:test";
import assert from "node:assert/strict";
import { executeInT3 } from "../src/t3-client.js";

const input = {
  site: "example.com",
  argv: ["/consumer"],
  field: "login",
  reason: "Sign in",
  ttlSeconds: 60,
};
test("request-only CLI transport initializes MCP and suppresses foreign credential extensions", async () => {
  const calls = [];
  const result = await executeInT3(input, {
    endpoint: "https://fake.invalid/mcp",
    authorization: "Bearer fake-request-only",
    fetchImplementation: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ body, headers: options.headers });
      if (body.method === "initialize")
        return Response.json(
          { id: body.id, result: {} },
          { headers: { "mcp-session-id": "fake-session" } },
        );
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(
        "event: message\ndata: " +
          JSON.stringify({
            id: body.id,
            result: {
              structuredContent: {
                requestId: "request",
                state: "completed",
                exitCode: 0,
                password: "fake-secret",
                credentialFile: "/private/file",
              },
            },
          }) +
          "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  assert.deepEqual(result, {
    kind: "exec",
    request_id: "request",
    state: "completed",
    exit_code: 0,
  });
  assert.deepEqual(
    calls.map((c) => c.body.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  assert.equal(calls[2].headers["mcp-session-id"], "fake-session");
  assert.deepEqual(calls[2].body.params, { name: "credential_broker_exec", arguments: input });
  assert(!JSON.stringify(result).includes("fake-secret"));
});
test("CLI interruption sends request cancellation without echoing transport errors", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(
    executeInT3(input, {
      endpoint: "https://fake.invalid/mcp",
      authorization: "Bearer fake-request-only",
      signal: controller.signal,
      fetchImplementation: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.method === "initialize") return Response.json({ result: {} });
        if (
          body.method === "notifications/initialized" ||
          body.method === "notifications/cancelled"
        )
          return new Response(null, { status: 202 });
        controller.abort();
        throw new Error("fake-secret");
      },
    }),
    /T3 credential request interrupted\./,
  );
  assert.equal(calls.at(-1).method, "notifications/cancelled");
  const call = calls.find((c) => c.method === "tools/call");
  assert.equal(calls.at(-1).params.requestId, call.id);
  assert.match(call.id, /^[a-f0-9-]{36}$/);
});
