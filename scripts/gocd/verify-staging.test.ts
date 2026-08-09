import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "../..");
const servers: NodeHttp.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

it("rejects an HTTP-ready candidate that does not publish a T3 Code metaproject", async () => {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200).end("ready");
      return;
    }
    if (request.url === "/.well-known/t3/environment") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ environmentId: "candidate", capabilities: {} }));
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");

  const result = await new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, ["scripts/gocd/verify-staging.mjs"], {
        cwd: root,
        env: {
          ...process.env,
          T3_STAGING_PORT: String(address.port),
          T3_PIPELINE_RUNTIME_ROOT: NodePath.join(root, ".tmp-pipeline-runtime"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("T3 Code metaproject");
});

it("rejects a published metaproject root without generated instructions", async () => {
  const runtimeRoot = NodePath.join(root, ".tmp-pipeline-runtime");
  const projectRoot = NodePath.join(runtimeRoot, "staging", "home", "t3code");
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200).end("ready");
      return;
    }
    if (request.url === "/.well-known/t3/environment") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          environmentId: "candidate",
          capabilities: {},
          t3CodeProjectRoot: projectRoot,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");

  const result = await new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, ["scripts/gocd/verify-staging.mjs"], {
        cwd: root,
        env: {
          ...process.env,
          T3_STAGING_PORT: String(address.port),
          T3_PIPELINE_RUNTIME_ROOT: runtimeRoot,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    },
  );

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("materialize the T3 Code metaproject instructions");
});
