// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Private browser/process adapter, outside instrumented RPCs.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type { Page, CDPSession, Locator } from "playwright-core";
import type { CredentialBrowserFailureStage, CredentialExecution } from "@t3tools/contracts";

export class BrowserCredentialFailure extends Error {
  readonly stage: CredentialBrowserFailureStage;
  readonly requestBlocked: boolean;

  constructor(stage: CredentialBrowserFailureStage, requestBlocked = false) {
    super("Private browser sign-in did not complete.");
    this.stage = stage;
    this.requestBlocked = requestBlocked;
  }
}

export interface BrowserLoginFields {
  readonly usernameSelector: string;
  readonly usernameSubmitSelector?: string | undefined;
  readonly passwordSelector: string;
  readonly submitSelector: string;
  readonly successSelector?: string | undefined;
}

/** Trusted consumer: callers must suspend observation before shared-tab entry. */
export async function consumeBrowserLogin(input: {
  readonly page: Page;
  readonly url: string;
  readonly fields: BrowserLoginFields;
  readonly login: { username: string; password: string };
  readonly signal: AbortSignal;
  readonly checkTarget: () => boolean;
  readonly sharedTab?: boolean;
  readonly createPrivatePage?:
    | (() => Promise<{ page: Page; close: () => Promise<void> }>)
    | undefined;
}) {
  const original = new URL(input.url);
  if (!["http:", "https:"].includes(original.protocol) || original.username || original.password)
    throw new BrowserCredentialFailure("target_changed");
  if (input.signal.aborted || !input.checkTarget())
    throw new BrowserCredentialFailure("target_changed");
  let stage: CredentialBrowserFailureStage = "delivery";
  let blockedRequest = false;
  let login: { username: string; password: string } | undefined;
  let privatePage: Page | undefined;
  let cdp: CDPSession | undefined;
  let closePrivatePage: (() => Promise<void>) | undefined;
  let routeHandler: Parameters<Page["route"]>[1] | undefined;
  const closePopup = (popup: Page) => {
    void popup.close().catch(() => {});
  };
  let sharedDocumentClean = !input.sharedTab;
  const abort = () => {
    if (input.sharedTab)
      void input.page
        .goto("about:blank", { waitUntil: "commit", timeout: 5000 })
        .catch(() => input.page.close().catch(() => {}));
    void closePrivatePage?.().catch(() => {});
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
    stage = "private_page";
    if (input.sharedTab) {
      privatePage = input.page;
    } else if (input.createPrivatePage) {
      const created = await input.createPrivatePage();
      privatePage = created.page;
      closePrivatePage = created.close;
    } else {
      privatePage = await input.page.context().newPage();
      closePrivatePage = () => signInPage.close();
    }
    const signInPage = privatePage;
    if (input.signal.aborted) throw new Error();
    stage = "connection";
    cdp = await privatePage.context().newCDPSession(privatePage);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    privatePage.on("popup", closePopup);
    let filled = false;
    // Redirects and form posts may not move approved credentials to another origin.
    routeHandler = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        input.signal.aborted ||
        !input.checkTarget() ||
        (filled && url.origin !== original.origin) ||
        (filled &&
          (!login ||
            [login.username, login.password].some(
              (value) => url.href.includes(encodeURIComponent(value)) || url.href.includes(value),
            ))) ||
        ((request.isNavigationRequest() ||
          !["GET", "HEAD", "OPTIONS"].includes(request.method())) &&
          url.origin !== original.origin)
      ) {
        blockedRequest = true;
        await route.abort();
      } else await route.continue();
    };
    await privatePage.route("**/*", routeHandler);
    stage = "navigation";
    if (input.sharedTab) {
      await privatePage.goto("about:blank", { waitUntil: "commit", timeout: 5000 });
      await cdp.send("Page.resetNavigationHistory");
      await cdp.send("Runtime.discardConsoleEntries");
    }
    await privatePage.goto(original.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (new URL(privatePage.url()).origin !== original.origin || !input.checkTarget())
      throw new BrowserCredentialFailure("target_changed");
    const checkTarget = () => {
      if (
        input.signal.aborted ||
        !input.checkTarget() ||
        new URL(signInPage.url()).origin !== original.origin
      )
        throw new BrowserCredentialFailure("target_changed");
    };
    const visible = async (selector: string) => {
      const locator = signInPage.locator(selector).filter({ visible: true });
      await locator.waitFor({ state: "visible", timeout: 15_000 });
      if ((await locator.count()) !== 1) throw new Error();
      return locator;
    };
    const protectForm = async (field: Locator, submit: Locator) => {
      checkTarget();
      const form = field.locator("xpath=ancestor::form[1]");
      for (const action of [
        (await form.count()) ? await form.getAttribute("action") : null,
        await submit.getAttribute("formaction"),
      ]) {
        if (new URL(action ?? signInPage.url(), signInPage.url()).origin !== original.origin)
          throw new BrowserCredentialFailure("request_policy");
      }
      if (await form.count()) {
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
    };
    stage = "username";
    const username = await visible(input.fields.usernameSelector);
    if (input.fields.usernameSubmitSelector) {
      const next = await visible(input.fields.usernameSubmitSelector);
      await protectForm(username, next);
      filled = true;
      await username.fill(login.username, { timeout: 5000 });
      checkTarget();
      if (input.sharedTab) await next.dispatchEvent("click", undefined, { timeout: 5000 });
      else await next.click({ timeout: 5000 });
    }
    stage = "password";
    const password = await visible(input.fields.passwordSelector);
    const submit = await visible(input.fields.submitSelector);
    const passwordType = await password.getAttribute("type");
    if (passwordType?.toLowerCase() !== "password") throw new Error();
    await protectForm(password, submit);
    filled = true;
    if (!input.fields.usernameSubmitSelector) {
      await username.fill(login.username, { timeout: 5000 });
    }
    checkTarget();
    await password.fill(login.password, { timeout: 5000 });
    checkTarget();
    stage = "submit";
    // Hidden desktop guests cannot receive pointer input. Only this approved consumer
    // dispatches the form control event; ordinary tools remain excluded by the reservation.
    if (input.sharedTab) await submit.dispatchEvent("click", undefined, { timeout: 5000 });
    else await submit.click({ timeout: 5000 });
    await password.waitFor({ state: "hidden", timeout: 15_000 });
    checkTarget();
    if (blockedRequest) throw new BrowserCredentialFailure("request_policy", true);
    if (input.fields.successSelector) {
      stage = "verification";
      await visible(input.fields.successSelector);
    }
    if (input.sharedTab) {
      // A fresh document removes filled forms, page closures and cached console objects.
      // Navigating this same tab retains sessionStorage; transferring it to a new tab does not.
      stage = "cleanup";
      const destination = signInPage.url();
      if (
        [login.username, login.password].some(
          (value) => destination.includes(value) || destination.includes(encodeURIComponent(value)),
        )
      )
        throw new BrowserCredentialFailure("request_policy");
      await signInPage.goto("about:blank", { waitUntil: "commit", timeout: 5000 });
      await signInPage.goto(destination, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await cdp.send("Page.resetNavigationHistory");
      await cdp.send("Runtime.discardConsoleEntries");
      if (input.signal.aborted || !input.checkTarget())
        throw new BrowserCredentialFailure("target_changed");
      sharedDocumentClean = true;
      if (input.fields.successSelector) {
        stage = "verification";
        await visible(input.fields.successSelector);
      }
      return input.fields.successSelector ? ("authenticated" as const) : ("submitted" as const);
    }
    await closePrivatePage!();
    privatePage = undefined;
    closePrivatePage = undefined;
    stage = "session_refresh";
    await input.page.goto(original.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return "submitted" as const;
  } catch (error) {
    throw new BrowserCredentialFailure(
      error instanceof BrowserCredentialFailure ? error.stage : stage,
      blockedRequest,
    );
  } finally {
    login = undefined;
    input.signal.removeEventListener("abort", abort);
    if (input.sharedTab && !sharedDocumentClean) {
      // Failure/revocation never exposes the partially filled document to observers.
      const blanked = await (async () => {
        await input.page.goto("about:blank", { waitUntil: "commit", timeout: 5000 });
        await cdp?.send("Page.resetNavigationHistory");
        await cdp?.send("Runtime.discardConsoleEntries");
      })().then(
        () => true,
        () => false,
      );
      if (!blanked) await input.page.close().catch(() => {});
      if (!blanked && !input.page.isClosed())
        await Promise.reject(new BrowserCredentialFailure("cleanup"));
    }
    privatePage?.off("popup", closePopup);
    if (privatePage && routeHandler)
      await privatePage.unroute("**/*", routeHandler).catch(() => {});
    if (input.sharedTab) {
      await cdp?.send("Runtime.discardConsoleEntries").catch(() => {});
      await cdp?.send("Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
    }
    await closePrivatePage?.().catch(() => {});
    await cdp?.detach().catch(() => {});
  }
}

/** One-use loopback capability; only its supervised process receives the URL. */
export async function createBrowserLoginBridge(
  consume: (
    login: { username: string; password: string },
    signal: AbortSignal,
  ) => Promise<void | "submitted" | "authenticated">,
) {
  const capability = `/${NodeCrypto.randomUUID()}`;
  const abort = new AbortController();
  let used = false;
  let consuming: ReturnType<typeof consume> | undefined;
  let failure: Pick<
    CredentialExecution,
    "browserFailureStage" | "browserRequestBlocked" | "browserOutcome"
  > = {};
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
      consuming = consume({ username: value.username, password: value.password }, abort.signal);
      const outcome = await consuming;
      if (outcome) failure = { browserOutcome: outcome };
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    } catch (error) {
      failure = {
        browserFailureStage: error instanceof BrowserCredentialFailure ? error.stage : "delivery",
        browserRequestBlocked: error instanceof BrowserCredentialFailure && error.requestBlocked,
      };
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
    failure: () => failure,
    close: async () => {
      abort.abort();
      server.closeAllConnections();
      await consuming?.catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
