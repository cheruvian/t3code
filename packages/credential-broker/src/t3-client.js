import { randomUUID } from "node:crypto";
import { BrokerError } from "./common.js";

/** Request-only MCP compatibility transport; never accepts an operator capability. */
export async function executeInT3(
  input,
  { endpoint, authorization, signal, fetchImplementation = fetch },
) {
  const callId = randomUUID();
  let session;
  async function rpc(id, method, params, callSignal = signal) {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      signal: callSignal ?? undefined,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        "mcp-protocol-version": "2025-06-18",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new BrokerError("T3 credential request failed. Review access in T3.");
    session = response.headers.get("mcp-session-id") ?? session;
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      return {};
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      return response.json();
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 65536) throw new BrokerError("Invalid T3 credential response.");
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^(?:\r?\n){2}/, "");
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const envelope = JSON.parse(data);
        if (envelope.id === id) return envelope;
      }
    }
    throw new BrokerError("T3 credential response ended before completion.");
  }
  try {
    const initialized = await rpc(callId + ":initialize", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "credential-broker", version: "0.1.0" },
    });
    if (initialized.error) throw new Error();
    await rpc(undefined, "notifications/initialized", {});
    const envelope = await rpc(callId, "tools/call", {
      name: "credential_broker_exec",
      arguments: input,
    });
    if (envelope.error || envelope.result?.isError) throw new Error();
    const result =
      envelope.result?.structuredContent ??
      JSON.parse(envelope.result?.content?.find((c) => c.type === "text")?.text ?? "{}");
    if (typeof result.requestId !== "string" || typeof result.state !== "string") throw new Error();
    // Keep the CLI's metadata-only output independent of foreign response extensions.
    return {
      kind: "exec",
      request_id: result.requestId,
      state: result.state,
      ...(typeof result.expiresAt === "number" ? { expires_at: result.expiresAt } : {}),
      ...(typeof result.exitCode === "number" ? { exit_code: result.exitCode } : {}),
      ...(typeof result.signal === "string" ? { signal: result.signal } : {}),
    };
  } catch {
    if (signal?.aborted)
      await rpc(undefined, "notifications/cancelled", { requestId: callId }, null).catch(() => {});
    throw new BrokerError(
      signal?.aborted
        ? "T3 credential request interrupted."
        : "T3 credential request failed. Review access and vault status privately in T3.",
    );
  }
}
