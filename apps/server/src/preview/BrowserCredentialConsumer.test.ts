// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the private HTTP adapter with a real browser.
import * as NodeHttp from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { consumeBrowserLogin, createBrowserLoginBridge } from "./BrowserCredentialConsumer.ts";

describe("private browser credential delivery", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let server: NodeHttp.Server;
  let origin: string;
  let received: string[];
  const login = { username: "fake-browser-account", password: "fake-browser-password" };
  const fields = {
    usernameSelector: "#username",
    passwordSelector: "#password",
    submitSelector: "button",
  };
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    received = [];
    server = NodeHttp.createServer(async (request, response) => {
      if (request.url === "/login" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        received.push(body);
        response
          .writeHead(303, { "set-cookie": "signed-in=yes; Path=/; HttpOnly", location: "/" })
          .end();
      } else if (request.headers.cookie?.includes("signed-in=yes")) {
        response.end("<h1>Signed in</h1>");
      } else {
        response.setHeader("content-type", "text/html");
        const action = request.url === "/unsafe" ? "http://127.0.0.1:1/steal" : "/login";
        response.end(
          `<form method="post" action="${action}"><input id="username" name="username"><input id="password" name="password" type="password"><button>Sign in</button></form>`,
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(origin);
  });
  afterEach(async () => {
    await context?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const consume = (
    options: { signal?: AbortSignal; checkTarget?: () => boolean; url?: string } = {},
  ) =>
    consumeBrowserLogin({
      page,
      url: options.url ?? origin,
      fields,
      login,
      signal: options.signal ?? new AbortController().signal,
      checkTarget: options.checkTarget ?? (() => true),
    });
  it("submits privately, closes the private page, and shares only the authenticated session", async () => {
    const observed: string[] = [];
    page.on("request", (request) => observed.push(request.url() + (request.postData() ?? "")));
    await consume();
    expect(received).toEqual([new URLSearchParams(login).toString()]);
    expect(await page.locator("h1").textContent()).toBe("Signed in");
    expect(context.pages()).toEqual([page]);
    const visibleOutput = JSON.stringify({
      observed,
      body: await page.locator("body").innerText(),
    });
    expect(visibleOutput).not.toContain(login.username);
    expect(visibleOutput).not.toContain(login.password);
  });
  it("rejects a changed or no longer owned target before creating a page", async () => {
    await expect(consume({ checkTarget: () => false })).rejects.toThrow();
    expect(received).toEqual([]);
    expect(context.pages()).toEqual([page]);
  });
  it("rejects a form that posts to another origin without delivering credentials", async () => {
    await page.goto(origin + "/unsafe");
    await expect(consume({ url: origin + "/unsafe" })).rejects.toThrow();
    expect(received).toEqual([]);
    expect(context.pages()).toEqual([page]);
  });
  it("closes a private page when the supervised caller is stopped", async () => {
    const controller = new AbortController();
    const created = new Promise<Page>((resolve) => context.once("page", resolve));
    const pending = consume({ signal: controller.signal });
    const privatePage = await created;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(privatePage.isClosed()).toBe(true);
    expect(received).toEqual([]);
  });
  it("uses a one-use bridge and returns a generic error without secret values", async () => {
    const bridge = await createBrowserLoginBridge(async () => {
      throw new Error(login.password);
    });
    try {
      const rejected = await fetch(bridge.endpoint + "/wrong", { method: "POST" });
      expect(rejected.status).toBe(404);
      const response = await fetch(bridge.endpoint, {
        method: "POST",
        body: JSON.stringify(login),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Sign-in did not complete.");
      expect(
        (await fetch(bridge.endpoint, { method: "POST", body: JSON.stringify(login) })).status,
      ).toBe(404);
    } finally {
      await bridge.close();
    }
  });
});
