// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Private browser/process adapter, outside instrumented RPCs.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type { Page, CDPSession } from "playwright-core";

export interface BrowserLoginFields {
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
}

/** No page listeners, snapshots, recordings, returned account values, or raw browser errors. */
export async function consumeBrowserLogin(input: {
  readonly page: Page;
  readonly url: string;
  readonly fields: BrowserLoginFields;
  readonly login: { username: string; password: string };
  readonly signal: AbortSignal;
  readonly checkTarget: () => boolean;
}) {
  const original = new URL(input.url);
  if (!["http:", "https:"].includes(original.protocol) || original.username || original.password)
    throw new Error("Unsupported browser sign-in target.");
  if (input.signal.aborted || !input.checkTarget()) throw new Error();
  let login: { username: string; password: string } | undefined;
  let privatePage: Page | undefined;
  let cdp: CDPSession | undefined;
  const abort = () => {
    void privatePage?.close().catch(() => {});
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    login = input.login;
    if (
      !login ||
      typeof login.username !== "string" ||
      typeof login.password !== "string" ||
      !login.username ||
      !login.password
    )
      throw new Error();
    privatePage = await input.page.context().newPage();
    if (input.signal.aborted) throw new Error();
    cdp = await input.page.context().newCDPSession(privatePage);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    privatePage.on("popup", (popup) => {
      void popup.close().catch(() => {});
    });
    let filled = false;
    // Redirects and form posts may not move approved credentials to another origin.
    await privatePage.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        input.signal.aborted ||
        !input.checkTarget() ||
        (filled && url.origin !== original.origin) ||
        (filled &&
          url.search &&
          [login!.username, login!.password].some(
            (value) => url.href.includes(encodeURIComponent(value)) || url.href.includes(value),
          )) ||
        ((request.isNavigationRequest() ||
          !["GET", "HEAD", "OPTIONS"].includes(request.method())) &&
          url.origin !== original.origin)
      )
        await route.abort();
      else await route.continue();
    });
    await privatePage.goto(original.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (new URL(privatePage.url()).origin !== original.origin || !input.checkTarget())
      throw new Error();
    const username = privatePage.locator(input.fields.usernameSelector);
    const password = privatePage.locator(input.fields.passwordSelector);
    const submit = privatePage.locator(input.fields.submitSelector);
    if (
      (await username.count()) !== 1 ||
      (await password.count()) !== 1 ||
      (await submit.count()) !== 1
    )
      throw new Error();
    const passwordType = await password.getAttribute("type");
    if (passwordType?.toLowerCase() !== "password") throw new Error();
    const form = password.locator("xpath=ancestor::form[1]");
    if (await form.count()) {
      const action = await form.getAttribute("action");
      if (new URL(action ?? privatePage.url(), privatePage.url()).origin !== original.origin)
        throw new Error();
      // Prevent credentials entering a native GET URL; SPA submit handlers still run.
      await form.evaluate((element) =>
        element.addEventListener(
          "submit",
          (event: { preventDefault: () => void }) => {
            if (element.getAttribute("method")?.toLowerCase() !== "post") event.preventDefault();
          },
          { capture: true },
        ),
      );
    }
    if (input.signal.aborted || !input.checkTarget()) throw new Error();
    filled = true;
    await username.fill(login.username, { timeout: 5000 });
    if (input.signal.aborted || !input.checkTarget()) throw new Error();
    await password.fill(login.password, { timeout: 5000 });
    if (input.signal.aborted || !input.checkTarget()) throw new Error();
    await submit.click({ timeout: 5000 });
    await password.waitFor({ state: "hidden", timeout: 15_000 });
    if (input.signal.aborted || !input.checkTarget()) throw new Error();
    await privatePage.close();
    privatePage = undefined;
    // The working tab never receives the filled form or its diagnostic buffers.
    await input.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } finally {
    login = undefined;
    input.signal.removeEventListener("abort", abort);
    await privatePage?.close().catch(() => {});
    await cdp?.detach().catch(() => {});
  }
}

/** One-use loopback capability; only its supervised process receives the URL. */
export async function createBrowserLoginBridge(
  consume: (login: { username: string; password: string }, signal: AbortSignal) => Promise<void>,
) {
  const capability = `/${NodeCrypto.randomUUID()}`;
  const abort = new AbortController();
  let used = false;
  const server = NodeHttp.createServer(async (request, response) => {
    if (used || request.method !== "POST" || request.url !== capability) {
      response.writeHead(404).end();
      return;
    }
    used = true;
    response.once("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 65536) throw new Error();
      }
      const value: unknown = JSON.parse(body);
      if (
        !value ||
        typeof value !== "object" ||
        !("username" in value) ||
        !("password" in value) ||
        typeof value.username !== "string" ||
        typeof value.password !== "string" ||
        !value.username ||
        !value.password ||
        value.username.length > 4096 ||
        value.password.length > 4096
      )
        throw new Error();
      body = "";
      await consume({ username: value.username, password: value.password }, abort.signal);
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    } catch {
      response.writeHead(400).end("Sign-in did not complete.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return {
    endpoint: `http://127.0.0.1:${address.port}${capability}`,
    close: async () => {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
