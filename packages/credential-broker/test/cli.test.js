import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const execute = promisify(execFile);

test("T3 CLI forwards command names for broker-side lookup instead of resolving the CLI host PATH", async (t) => {
  let requested;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    let result = {};
    if (rpc.method === "tools/call") {
      requested = rpc.params.arguments;
      result = {
        structuredContent: { requestId: "fake-request", state: "completed", exitCode: 0 },
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const program = "t3-broker-test-only-remote-command";
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "exec",
      "--t3",
      "--site",
      "example.com",
      "--reason",
      "Verify host lookup",
      "--",
      program,
      "--consumer-option",
    ],
    {
      env: {
        ...process.env,
        T3_ACP_MCP_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        T3_ACP_MCP_AUTHORIZATION: "Bearer fake-request-only",
      },
    },
  );
  assert.deepEqual(requested.argv, [program, "--consumer-option"]);
  assert.equal(JSON.parse(stdout).state, "completed");
});

test("CLI rejects standalone commands and cannot start a consumer without a T3 session", async () => {
  const env = { ...process.env };
  delete env.T3_ACP_MCP_ENDPOINT;
  delete env.T3_ACP_MCP_AUTHORIZATION;
  for (const command of ["start", "request", "status", "release"]) {
    await assert.rejects(execute(process.execPath, [cli, command], { env }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /approval and vault unlock happen in T3/);
      return true;
    });
  }
  await assert.rejects(
    execute(
      process.execPath,
      [
        cli,
        "exec",
        "--site",
        "example.com",
        "--reason",
        "Test missing session",
        "--",
        "not-a-local-consumer",
      ],
      { env },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /No T3 request-only provider session is attached/);
      return true;
    },
  );
});
