import http from "node:http";
import { join } from "node:path";
import { BrokerError, DEFAULT_RUNTIME } from "./common.js";

export function callBroker(path, { runtime = DEFAULT_RUNTIME, method = "GET", data } = {}) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request(
      {
        socketPath: join(runtime, "agent.sock"),
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(raw);
            if (res.statusCode >= 400) reject(new BrokerError(result.error, res.statusCode));
            else resolve(result);
          } catch {
            reject(new BrokerError("Invalid broker response.", 502));
          }
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy());
    req.on("error", () =>
      reject(new BrokerError("Broker unavailable. Ask the human to start the companion app.", 503)),
    );
    req.end(payload);
  });
}

export async function waitForRequest(request, { runtime, timeout = 120_000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  while (
    ["searching", "pending", "preparing", "running"].includes(request.state) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    request = await callBroker(`/requests/${request.request_id}`, { runtime });
  }
  return request;
}
