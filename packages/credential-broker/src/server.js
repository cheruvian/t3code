import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { BrokerError } from "./common.js";

async function body(req) {
  if (req.headers["content-type"] !== "application/json")
    throw new BrokerError("Expected application/json.", 415);
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 8192) throw new BrokerError("Request body is too large.", 413);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrokerError("Invalid JSON.");
  }
}
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!res.headersSent)
        send(res, error instanceof BrokerError ? error.status : 500, {
          error: error instanceof BrokerError ? error.message : "Broker operation failed.",
        });
      else res.end();
    }
  };
}
function listen(server, address, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections();
  });
}

export async function startServers(
  broker,
  {
    port = 4317,
    host = "0.0.0.0",
    publicUrl = `http://cheruvia-mobile.tailf474c0.ts.net:${port}`,
    adminToken = randomBytes(32).toString("hex"),
  } = {},
) {
  const origin = new URL(publicUrl).origin;
  const socketPath = join(broker.runtime, "agent.sock");
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid())
      throw new BrokerError("Unsafe agent socket path.");
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const agent = http.createServer(
    handle(async (req, res) => {
      const path = req.url;
      if (req.method === "POST" && path === "/requests")
        return send(res, 201, broker.request(await body(req)));
      const match = /^\/requests\/([a-f0-9-]{36})(\/release)?$/.exec(path);
      if (match && req.method === "GET" && !match[2])
        return send(res, 200, await broker.status(match[1]));
      if (match && req.method === "POST" && match[2])
        return send(res, 200, await broker.release(match[1]));
      throw new BrokerError(
        "Unknown agent operation. Approval is available only in the human dashboard.",
        404,
      );
    }),
  );
  const operator = http.createServer(
    handle(async (req, res) => {
      const allowedHosts = new Set([
        new URL(origin).host,
        `localhost:${port}`,
        `127.0.0.1:${port}`,
      ]);
      if (port !== 0 && !allowedHosts.has(req.headers.host))
        throw new BrokerError("Unrecognized host.", 403);
      const securityHeaders = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
      for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
      if (req.url.startsWith("/api/")) {
        const token = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
        const expected = Buffer.from(adminToken);
        if (token.length !== expected.length || !timingSafeEqual(token, expected))
          throw new BrokerError("Human dashboard authentication required.", 401);
        if (
          req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== origin
        )
          throw new BrokerError("Unrecognized origin.", 403);
        if (req.method === "GET" && req.url === "/api/state")
          return send(res, 200, {
            mode: broker.provider.mode,
            requests: await broker.list(),
            grants: broker.grants.list(),
            notices: broker.notices(),
          });
        const match = /^\/api\/requests\/([a-f0-9-]{36})\/(approve|deny|release)$/.exec(req.url);
        if (match && req.method === "POST") {
          const selection = await body(req);
          if (
            !selection ||
            typeof selection !== "object" ||
            Array.isArray(selection) ||
            Object.keys(selection).some((key) => !["item_id", "always"].includes(key)) ||
            (selection.item_id !== undefined && typeof selection.item_id !== "string") ||
            (selection.always !== undefined && typeof selection.always !== "boolean")
          )
            throw new BrokerError("Invalid approval selection.");
          return send(
            res,
            200,
            match[2] === "release"
              ? await broker.release(match[1])
              : await broker.decide(
                  match[1],
                  match[2] === "approve",
                  selection.item_id,
                  selection.always === true,
                ),
          );
        }
        const grant = /^\/api\/grants\/([a-f0-9-]{36})\/revoke$/.exec(req.url);
        if (grant && req.method === "POST") {
          await body(req);
          return send(res, 200, await broker.revokeGrant(grant[1]));
        }
        const notice = /^\/api\/notices\/([a-f0-9-]{36})\/dismiss$/.exec(req.url);
        if (notice && req.method === "POST") {
          await body(req);
          broker.dismissNotice(notice[1]);
          return send(res, 200, { state: "dismissed" });
        }
        throw new BrokerError("Unknown dashboard operation.", 404);
      }
      const files = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      const file = files[req.url];
      if (req.method !== "GET" || !file) throw new BrokerError("Not found.", 404);
      res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
      res.end(await readFile(new URL(`../public/${file[0]}`, import.meta.url)));
    }),
  );
  agent.requestTimeout = operator.requestTimeout = 10_000;
  try {
    await listen(agent, socketPath);
    await chmod(socketPath, 0o600);
    await listen(operator, port, host);
  } catch (error) {
    await close(agent);
    await close(operator);
    throw error;
  }
  const actualPort = operator.address().port;
  return {
    socketPath,
    port: actualPort,
    adminToken,
    approvalUrl: `${publicUrl.replace(/\/$/, "")}/#token=${adminToken}`,
    async close() {
      await Promise.all([close(agent), close(operator)]);
      await unlink(socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
