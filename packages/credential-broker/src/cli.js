#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";
import { executeInT3 } from "./t3-client.js";
import { BrokerError } from "./common.js";

const help = `Credential Broker — T3-approved temporary credential files

  credential-broker exec --site HOST --reason REASON
      [--field password|username|login] [--label LABEL] [--ttl 60] [--cwd DIR]
      [--browser-tab TAB_ID]
      -- PROGRAM ARGS...

Requires an attached T3 request-only provider session. Approval and vault unlock
happen in T3's connected web, desktop, or mobile client. Native agents can call
credential_broker_exec directly. --t3 is accepted for compatibility.
The approved program reads CB_CREDENTIAL_FILE. Passwords and child stdout/stderr
are never printed. Files are removed on exit, cancellation, or expiry.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      site: { type: "string" },
      "browser-tab": { type: "string" },
      field: { type: "string", default: "password" },
      label: { type: "string" },
      reason: { type: "string" },
      ttl: { type: "string", default: "60" },
      cwd: { type: "string", default: process.cwd() },
      help: { type: "boolean" },
      t3: { type: "boolean" },
    },
  });
  const [command, ...argv] = positionals;
  if (values.help || !command || command === "help") {
    console.log(help);
    return;
  }
  if (command !== "exec")
    throw new BrokerError(
      "Use exec with an attached T3 session; approval and vault unlock happen in T3.",
    );
  if (!values.site || !values.reason || !argv[0])
    throw new BrokerError("Provide --site, --reason, and a program after --.");
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (!endpoint || !authorization)
    throw new BrokerError(
      "No T3 request-only provider session is attached. Use credential_broker_exec in T3.",
    );
  const cwd = await realpath(values.cwd).catch(() => {
    throw new BrokerError("Working directory does not exist.");
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await executeInT3(
      {
        site: values.site,
        ...(values["browser-tab"] ? { browserTabId: values["browser-tab"] } : {}),
        field: values.field,
        label: values.label ?? values.site,
        reason: values.reason,
        ttlSeconds: Number(values.ttl),
        argv,
        cwd,
      },
      { endpoint, authorization, signal: controller.signal },
    );
    console.log(JSON.stringify(result));
    process.exitCode =
      result.state === "revoked"
        ? 125
        : result.state === "completed" && result.exit_code === 0
          ? 0
          : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error:
        error instanceof BrokerError
          ? error.message
          : "Credential Broker failed. Review access and vault status in T3.",
    }),
  );
  process.exitCode = 1;
});
