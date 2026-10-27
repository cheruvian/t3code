// @effect-diagnostics nodeBuiltinImport:off - Consumer-only loopback transport; request bodies never enter RPC logging.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import {
  CredentialBrowserCommand,
  type CredentialBrowserCommand as Command,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";

const decode = Schema.decodeUnknownSync(CredentialBrowserCommand);

export async function createBrowserScriptBridge(input: {
  readonly page: Page;
  readonly run: <A>(action: () => Promise<A>) => Promise<A>;
}) {
  const path = `/${NodeCrypto.randomUUID()}`;
  let active = true;
  const dispatch = async (command: Command) => {
    if (!active || input.page.isClosed()) throw new Error();
    if (command.operation === "url") return input.page.url();
    const locator = input.page.locator(command.selector);
    switch (command.operation) {
      case "fill":
        await locator.fill(command.value, { timeout: 10_000 });
        return null;
      case "click":
        await locator.click({ timeout: 10_000 });
        return null;
      case "press":
        await locator.press(command.key, { timeout: 10_000 });
        return null;
      case "waitFor":
        await locator.waitFor({ state: command.state ?? "visible", timeout: 15_000 });
        return null;
      case "isVisible":
        return locator.isVisible();
    }
  };
  const server = NodeHttp.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!active || request.method !== "POST" || request.url !== path || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 65_536) throw new Error();
      }
      const command = decode(JSON.parse(body));
      body = "";
      const result = await input.run(() => dispatch(command));
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ result }));
    } catch {
      // Playwright errors can quote a filled value, selector, or page contents.
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "browser_action_failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return {
    endpoint: `http://127.0.0.1:${address.port}${path}`,
    close: async () => {
      active = false;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
