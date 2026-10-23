// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the private HTTP adapter with a real browser.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { executeManualCredential } from "@t3tools/credential-broker/manual";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  consumeBrowserLogin,
  createBrowserLoginBridge,
  type BrowserLoginFields,
} from "./BrowserCredentialConsumer.ts";

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
      } else if (request.url?.startsWith("/username") && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        received.push(body);
        if (request.url === "/username-spa") response.writeHead(204).end();
        else
          response
            .writeHead(303, { location: request.url.replace("/username", "/password") })
            .end();
      } else if (request.url?.startsWith("/staged")) {
        response.setHeader("content-type", "text/html");
        if (request.url === "/staged-spa") {
          response.end(
            `<form id="username-step" method="post" action="/username-spa"><input id="username" name="username"><input id="password" name="password" type="password" hidden><button id="next">Next</button></form>
            <form id="password-step" method="post" action="/login" hidden><input id="password" name="password" type="password"><button>Sign in</button></form>
            <script>document.getElementById('username-step').addEventListener('submit', async (event) => {
              event.preventDefault();
              await fetch('/username-spa', { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
              event.target.hidden = true;
              document.getElementById('password-step').hidden = false;
            });</script>`,
          );
          return;
        }
        const action =
          request.url === "/staged-username-unsafe"
            ? "http://127.0.0.1:1/steal"
            : request.url.replace("/staged", "/username");
        response.end(
          `<form method="post" action="${action}"><input id="username" name="username"><input id="password" name="password" type="password" hidden><button id="next">Next</button></form>`,
        );
      } else if (request.url?.startsWith("/password")) {
        response.setHeader("content-type", "text/html");
        const action = request.url === "/password-unsafe" ? "http://127.0.0.1:1/steal" : "/login";
        response.end(
          `<form method="post" action="${action}"><input id="password" name="password" type="password"><button>Sign in</button></form>`,
        );
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
    options: {
      signal?: AbortSignal;
      checkTarget?: () => boolean;
      url?: string;
      fields?: BrowserLoginFields;
    } = {},
  ) =>
    consumeBrowserLogin({
      page,
      url: options.url ?? origin,
      fields: options.fields ?? fields,
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
  it("uses a supplied private desktop page and closes its dedicated connection", async () => {
    let closed = 0;
    const observed: string[] = [];
    page.on("request", (request) => observed.push(request.url() + (request.postData() ?? "")));
    await consumeBrowserLogin({
      page,
      url: origin,
      fields,
      login,
      signal: new AbortController().signal,
      checkTarget: () => true,
      createPrivatePage: async () => {
        const privatePage = await context.newPage();
        return {
          page: privatePage,
          close: async () => {
            closed++;
            await privatePage.close();
          },
        };
      },
    });
    expect(closed).toBe(1);
    expect(await page.locator("h1").textContent()).toBe("Signed in");
    expect(context.pages()).toEqual([page]);
    expect(JSON.stringify(observed)).not.toContain(login.username);
    expect(JSON.stringify(observed)).not.toContain(login.password);
  });
  it("rejects a changed or no longer owned target before creating a page", async () => {
    await expect(consume({ checkTarget: () => false })).rejects.toThrow();
    expect(received).toEqual([]);
    expect(context.pages()).toEqual([page]);
  });
  it.each(["/staged", "/staged-spa"])(
    "submits the username before the visible password step on %s",
    async (path) => {
      await page.goto(origin + path);
      const observed: string[] = [];
      page.on("request", (request) => observed.push(request.url() + (request.postData() ?? "")));
      await consume({
        url: origin + path,
        fields: { ...fields, usernameSubmitSelector: "#next" },
      });
      expect(received).toEqual([
        new URLSearchParams({ username: login.username, password: "" }).toString(),
        new URLSearchParams({ password: login.password }).toString(),
      ]);
      expect(await page.locator("h1").textContent()).toBe("Signed in");
      expect(context.pages()).toEqual([page]);
      const visibleOutput = JSON.stringify({
        observed,
        body: await page.locator("body").innerText(),
      });
      expect(visibleOutput).not.toContain(login.username);
      expect(visibleOutput).not.toContain(login.password);
    },
  );
  it("delivers a private login through the supervised worker and bridge into a staged browser session", async () => {
    await page.goto(origin + "/staged");
    const runtime = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-staged-login-"));
    const bridge = await createBrowserLoginBridge((privateLogin, signal) =>
      consumeBrowserLogin({
        page,
        url: origin + "/staged",
        fields: { ...fields, usernameSubmitSelector: "#next" },
        login: privateLogin,
        signal,
        checkTarget: () => true,
      }),
    );
    try {
      const host = NodePath.join(runtime, "host.mjs");
      await NodeFSP.writeFile(
        host,
        `import { runCredentialWorker } from ${JSON.stringify(import.meta.resolve("@t3tools/credential-broker/worker"))}; await runCredentialWorker(process.argv[3]);`,
      );
      const workerEntrypoint = [host, "__credential-broker-worker"];
      const result = await executeManualCredential({
        runtime,
        workerEntrypoint,
        origin: {
          environmentId: EnvironmentId.make("test-environment"),
          threadId: ThreadId.make("test-thread"),
          threadTitle: "Staged sign-in test",
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "test-session",
          runId: "test-run",
          toolCallId: "test-call",
          workspace: runtime,
          agent: "test-agent",
        },
        input: {
          site: "127.0.0.1",
          field: "login",
          label: "Staged sign-in",
          reason: "Test private delivery",
          ttlSeconds: 60,
          cwd: runtime,
          argv: [process.execPath, ...workerEntrypoint, "browser"],
        },
        login,
        consumerEnvironment: { CB_BROWSER_ENDPOINT: bridge.endpoint },
      });
      expect(result).toMatchObject({ state: "completed", exitCode: 0 });
      expect(JSON.stringify(result)).not.toContain(login.username);
      expect(JSON.stringify(result)).not.toContain(login.password);
      expect(await page.locator("h1").textContent()).toBe("Signed in");
      expect(context.pages()).toEqual([page]);
      expect(await NodeFSP.readdir(NodePath.join(runtime, "manual"))).toEqual([]);
    } finally {
      await bridge.close();
      await NodeFSP.rm(runtime, { recursive: true, force: true });
    }
  });
  it("rejects a cross-origin password form after the username step without delivering the password", async () => {
    await page.goto(origin + "/staged-unsafe");
    await expect(
      consume({
        url: origin + "/staged-unsafe",
        fields: { ...fields, usernameSubmitSelector: "#next" },
      }),
    ).rejects.toThrow();
    expect(received).toEqual([
      new URLSearchParams({ username: login.username, password: "" }).toString(),
    ]);
    expect(context.pages()).toEqual([page]);
    expect(await page.locator("#username").inputValue()).toBe("");
  });
  it("rejects a cross-origin username form before delivering either field", async () => {
    await page.goto(origin + "/staged-username-unsafe");
    await expect(
      consume({
        url: origin + "/staged-username-unsafe",
        fields: { ...fields, usernameSubmitSelector: "#next" },
      }),
    ).rejects.toThrow();
    expect(received).toEqual([]);
    expect(context.pages()).toEqual([page]);
  });
  it("stops before filling the password when ownership changes between steps", async () => {
    await page.goto(origin + "/staged");
    await expect(
      consume({
        url: origin + "/staged",
        fields: { ...fields, usernameSubmitSelector: "#next" },
        checkTarget: () => !context.pages().some((tab) => tab.url() === origin + "/password"),
      }),
    ).rejects.toThrow();
    expect(received).toEqual([
      new URLSearchParams({ username: login.username, password: "" }).toString(),
    ]);
    expect(context.pages()).toEqual([page]);
  });
  it("closes the private page when the username step is cancelled", async () => {
    await page.goto(origin + "/staged");
    const controller = new AbortController();
    context.once("page", (privatePage) => {
      privatePage.on("request", (request) => {
        if (request.url() === origin + "/password") controller.abort();
      });
    });
    await expect(
      consume({
        url: origin + "/staged",
        fields: { ...fields, usernameSubmitSelector: "#next" },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(received).toEqual([
      new URLSearchParams({ username: login.username, password: "" }).toString(),
    ]);
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
      expect(bridge.failure()).toEqual({
        browserFailureStage: "delivery",
        browserRequestBlocked: false,
      });
      expect(JSON.stringify(bridge.failure())).not.toContain(login.password);
      expect(
        (await fetch(bridge.endpoint, { method: "POST", body: JSON.stringify(login) })).status,
      ).toBe(404);
    } finally {
      await bridge.close();
    }
  });

  it("reports private page creation failure without retaining the underlying error", async () => {
    const bridge = await createBrowserLoginBridge((privateLogin, signal) =>
      consumeBrowserLogin({
        page,
        url: origin,
        fields,
        login: privateLogin,
        signal,
        checkTarget: () => true,
        createPrivatePage: async () => {
          throw new Error(login.password);
        },
      }),
    );
    try {
      expect(bridge.failure()).toEqual({});
      const response = await fetch(bridge.endpoint, {
        method: "POST",
        body: JSON.stringify(login),
      });
      expect(response.status).toBe(400);
      expect(bridge.failure()).toEqual({
        browserFailureStage: "private_page",
        browserRequestBlocked: false,
      });
      expect(await response.text()).not.toContain(login.password);
      expect(JSON.stringify(bridge.failure())).not.toContain(login.password);
      expect(context.pages()).toEqual([page]);
    } finally {
      await bridge.close();
    }
  });

  it.each([
    { path: "/", fields: { ...fields, usernameSelector: "[" }, stage: "username", blocked: false },
    { path: "/", fields: { ...fields, passwordSelector: "[" }, stage: "password", blocked: false },
    { path: "/unsafe", fields, stage: "request_policy", blocked: false },
  ])("identifies $stage failures without returning private page diagnostics", async (fixture) => {
    const bridge = await createBrowserLoginBridge((privateLogin, signal) =>
      consumeBrowserLogin({
        page,
        url: origin + fixture.path,
        fields: fixture.fields,
        login: privateLogin,
        signal,
        checkTarget: () => true,
      }),
    );
    try {
      const response = await fetch(bridge.endpoint, {
        method: "POST",
        body: JSON.stringify(login),
      });
      expect(response.status).toBe(400);
      expect(bridge.failure()).toEqual({
        browserFailureStage: fixture.stage,
        browserRequestBlocked: fixture.blocked,
      });
      expect(received).toEqual([]);
      expect(context.pages()).toEqual([page]);
    } finally {
      await bridge.close();
    }
  });

  it("reports a blocked request when the target changes during private page creation", async () => {
    let targetCurrent = true;
    const bridge = await createBrowserLoginBridge((privateLogin, signal) =>
      consumeBrowserLogin({
        page,
        url: origin,
        fields,
        login: privateLogin,
        signal,
        checkTarget: () => targetCurrent,
        createPrivatePage: async () => {
          const privatePage = await context.newPage();
          targetCurrent = false;
          return { page: privatePage, close: () => privatePage.close() };
        },
      }),
    );
    try {
      const response = await fetch(bridge.endpoint, {
        method: "POST",
        body: JSON.stringify(login),
      });
      expect(response.status).toBe(400);
      expect(bridge.failure()).toEqual({
        browserFailureStage: "navigation",
        browserRequestBlocked: true,
      });
      expect(received).toEqual([]);
      expect(context.pages()).toEqual([page]);
    } finally {
      await bridge.close();
    }
  });
});
