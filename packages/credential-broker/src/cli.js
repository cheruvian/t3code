#!/usr/bin/env node
import { executeInT3 } from "./t3-client.js";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { Broker } from "./broker.js";
import { BitwardenProvider, DemoProvider } from "./providers.js";
import { startServers } from "./server.js";
import { callBroker, waitForRequest } from "./client.js";
import { BrokerError, DEFAULT_RUNTIME } from "./common.js";
import { nativeApproval } from "./native-approval.js";
import { DesktopPresenter } from "./desktop-presenter.js";
import { NativeNotifier } from "./native-notifier.js";

const help = `Credential Broker PoC — human-approved temporary credential files

Human terminal:
  credential-broker start --demo [--port 4317] [--no-open]
  credential-broker start --bitwarden [--bw /absolute/path/to/bw]
      [--approval desktop|native|dashboard] (live default: desktop)

Agent interface (CLI only; passwords and child output are never printed):
  credential-broker exec --site HOST --label LABEL --reason REASON
      [--ttl 60] [--cwd DIR] [--file-env CB_CREDENTIAL_FILE] -- PROGRAM ARGS...
  credential-broker request --item UUID --label LABEL --reason REASON
      [--field password|username|login] [--client NAME] [--ttl 60] [--wait]
  credential-broker status REQUEST_ID
  credential-broker release REQUEST_ID

exec --t3 uses the attached T3 request-only MCP session and remote approval UI.\nACP sessions select T3 automatically. Standalone commands accept --runtime DIR. Requests return JSON metadata, never a password.
Use either --site HOST (search and human selection) or --item UUID.
--field login delivers a JSON file with username and password after one approval.
start prints a private human approval link: do not run it through an agent's tools.
Dashboard default: http://cheruvia-mobile.tailf474c0.ts.net:4317
Options: --host ADDRESS, --public-url URL (human dashboard address).
exec triggers approval and waits. The program receives a credential-file path in
CB_CREDENTIAL_FILE. Its stdout/stderr are discarded. Files are removed on exit,
release, or timeout. Never echo/read credentials into agent output.
`;

async function executablePath(program, cwd) {
  if (!program) throw new BrokerError("Provide a program after --.");
  const candidates = program.includes("/")
    ? [resolve(cwd, program)]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir || cwd, program));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {}
  }
  throw new BrokerError("Program was not found or is not executable.");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      runtime: { type: "string", default: DEFAULT_RUNTIME },
      demo: { type: "boolean" },
      bitwarden: { type: "boolean" },
      "no-open": { type: "boolean" },
      approval: { type: "string" },
      port: { type: "string", default: "4317" },
      host: { type: "string", default: "0.0.0.0" },
      "public-url": { type: "string" },
      bw: { type: "string" },
      item: { type: "string" },
      site: { type: "string" },
      label: { type: "string" },
      reason: { type: "string" },
      field: { type: "string", default: "password" },
      client: { type: "string", default: "CLI agent (unverified)" },
      ttl: { type: "string", default: "60" },
      wait: { type: "boolean" },
      cwd: { type: "string", default: process.cwd() },
      "file-env": { type: "string", default: "CB_CREDENTIAL_FILE" },
      help: { type: "boolean" },
      t3: { type: "boolean" },
    },
  });
  const [command, id] = positionals;
  if (values.help || !command || command === "help") {
    console.log(help);
    return;
  }
  const runtime = values.runtime;
  if (command === "start") {
    if (!!values.demo === !!values.bitwarden)
      throw new BrokerError("Choose exactly one of --demo or --bitwarden.");
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new BrokerError("Port must be 1–65535.");
    const publicUrl = values["public-url"] ?? `http://cheruvia-mobile.tailf474c0.ts.net:${port}`;
    const parsedUrl = new URL(publicUrl);
    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.pathname !== "/" ||
      parsedUrl.search ||
      parsedUrl.hash
    )
      throw new BrokerError("Public URL must be an HTTP(S) origin.");
    if (process.platform === "win32")
      throw new BrokerError(
        "The desktop UI is portable; Windows broker ACL and process supervision are not yet supported.",
      );
    const mode = values.approval ?? (values.bitwarden ? "desktop" : "dashboard");
    if (!["desktop", "native", "dashboard"].includes(mode))
      throw new BrokerError("Approval must be desktop, native, or dashboard.");
    if (mode === "native" && process.platform !== "darwin")
      throw new BrokerError("Native approval requires macOS.");
    const desktop = mode === "desktop" ? new DesktopPresenter() : undefined;
    if (desktop) await desktop.start();
    const broker = new Broker({
      runtime,
      provider: values.demo
        ? new DemoProvider()
        : new BitwardenProvider({
            executable: values.bw,
            ...(desktop ? { passwordPrompt: () => desktop.unlock() } : {}),
          }),
      approver: desktop
        ? desktop.approve.bind(desktop)
        : mode === "native"
          ? nativeApproval
          : undefined,
      notifier:
        desktop ?? (process.platform === "darwin" ? new NativeNotifier(runtime) : undefined),
    });
    try {
      await broker.initialize();
    } catch (error) {
      desktop?.close();
      throw error;
    }
    let servers;
    try {
      servers = await startServers(broker, {
        port,
        host: values.host,
        publicUrl,
      });
    } catch (error) {
      await broker.close();
      throw error;
    }
    let stateTimer;
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(stateTimer);
      try {
        await servers.close();
        await broker.close();
        process.exitCode = 0;
      } catch {
        console.error(
          "Shutdown cleanup failed. Detached expiry timers remain active; inspect the private lease directory.",
        );
        process.exitCode = 1;
      }
    };
    if (desktop) {
      let desktopError;
      desktop.onAction = (action, id) => {
        if (action === "quit") void stop();
        else if (action === "revoke")
          void broker.revokeGrant(id).catch(() => {
            desktopError =
              "Access stopped, but saving the permission change failed. Restart and review permissions.";
          });
        else if (action === "release")
          void broker.release(id).catch(() => {
            desktopError = "Could not stop access. Quit the broker and review the command.";
          });
      };
      const publish = async () =>
        desktop.state({
          status: "ready",
          error: desktopError,
          runtime: broker.runtime,
          requests: await broker.list(),
          grants: broker.grants.list(),
        });
      await publish();
      stateTimer = setInterval(() => {
        void publish().catch(() => {});
      }, 1000);
      stateTimer.unref();
    }
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log(
      `Credential Broker (${broker.provider.mode}) is running.\nAgent runtime: ${runtime}\nPRIVATE HUMAN APPROVAL LINK (keep out of agent context):\n${servers.approvalUrl}`,
    );
    if (!broker.approver && !values["no-open"] && process.platform === "darwin")
      execFile("/usr/bin/open", [servers.approvalUrl], () => {});
    return;
  }
  if (command === "mcp")
    throw new BrokerError("This broker is CLI-only. Use exec, request, status, or release.");
  let result;
  if (["request", "exec"].includes(command)) {
    const cwd = await realpath(values.cwd).catch(() => {
      throw new BrokerError("Working directory does not exist.");
    });
    const argv =
      command === "exec"
        ? [await executablePath(positionals[1], cwd), ...positionals.slice(2)]
        : undefined;
    if (values.t3 || (command === "exec" && process.env.T3_ACP_MCP_ENDPOINT)) {
      if (command !== "exec" || !values.site || values.item)
        throw new BrokerError(
          "T3 credential access requires exec with --site; separate file leases are standalone only.",
        );
      if (values["file-env"] !== "CB_CREDENTIAL_FILE")
        throw new BrokerError("T3 credential delivery uses CB_CREDENTIAL_FILE.");
      const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
      const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
      if (!endpoint || !authorization)
        throw new BrokerError("No T3 request-only provider session is attached.");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        result = await executeInT3(
          {
            site: values.site,
            field: values.field,
            label: values.label ?? values.site,
            reason: values.reason,
            ttlSeconds: Number(values.ttl),
            argv,
            cwd,
          },
          { endpoint, authorization, signal: controller.signal },
        );
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      console.log(JSON.stringify(result));
      process.exitCode =
        result.state === "revoked"
          ? 125
          : result.state === "completed" && result.exit_code === 0
            ? 0
            : 1;
      return;
    }
    result = await callBroker("/requests", {
      runtime,
      method: "POST",
      data: {
        kind: command === "exec" ? "exec" : "file",
        item_id: values.item,
        site: values.site,
        label: values.label ?? values.site,
        reason: values.reason,
        field: values.field,
        client: values.client,
        ttl_seconds: Number(values.ttl),
        ...(argv ? { argv, cwd, file_env: values["file-env"] } : {}),
      },
    });
    if (command === "exec") {
      const id = result.request_id;
      const cancel = async () => {
        try {
          await callBroker(`/requests/${id}/release`, {
            runtime,
            method: "POST",
          });
        } catch {}
        process.exit(130);
      };
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        result = await waitForRequest(result, {
          runtime,
          timeout: 120_000 + Number(values.ttl) * 1000 + 10_000,
        });
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    } else if (values.wait) result = await waitForRequest(result, { runtime });
  } else if (["status", "release"].includes(command)) {
    if (!/^[a-f0-9-]{36}$/.test(id ?? "")) throw new BrokerError("Provide the request UUID.");
    result = await callBroker(`/requests/${id}${command === "release" ? "/release" : ""}`, {
      runtime,
      method: command === "release" ? "POST" : "GET",
    });
  } else throw new BrokerError("Unknown command. Use --help.");
  console.log(JSON.stringify(result, null, 2));
  if (["failed", "denied", "expired"].includes(result.state)) process.exitCode = 1;
  if (result.kind === "exec")
    process.exitCode = result.state === "completed" && result.exit_code === 0 ? 0 : 1;
  if (result.state === "revoked") process.exitCode = 125;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error:
        error instanceof BrokerError
          ? error.message
          : "Credential Broker failed. Check configuration in the human terminal.",
    }),
  );
  process.exitCode = 1;
});
