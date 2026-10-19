import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { Broker } from "./broker.js";
import runnerProgram from "./runner-program.js";
import watchdogProgram from "./watchdog-program.js";

/** Called only after an authenticated human submits the private one-use form. */
export async function executeManualCredential({
  runtime,
  workerEntrypoint,
  origin,
  input,
  login,
  consumerEnvironment,
  signal,
}) {
  const directory = join(runtime, "manual", randomUUID());
  const item = randomUUID();
  let value = JSON.stringify(login);
  let request;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const broker = new Broker({
    runtime: directory,
    workerEntrypoint,
    runnerProgram,
    watchdogProgram,
    approvalTimeout: null,
    provider: {
      mode: "manual",
      initialize: async () => {},
      get: async () => value,
      close: async () => {
        value = undefined;
      },
    },
    onChange: () => {
      const state = broker.snapshot().requests.find((r) => r.request_id === request?.request_id);
      if (
        state?.settled &&
        ["completed", "failed", "denied", "expired", "released", "revoked"].includes(state.state)
      )
        finish({
          requestId: state.request_id,
          state: state.state,
          exitCode: state.exit_code ?? null,
        });
    },
  });
  const abort = () => {
    if (request) void broker.release(request.request_id);
  };
  try {
    if (signal?.aborted) throw new Error("Manual sign-in cancelled.");
    await mkdir(join(runtime, "manual"), { recursive: true, mode: 0o700 });
    await broker.initialize();
    request = broker.request(
      {
        kind: "exec",
        item_id: item,
        field: "login",
        label: input.label,
        reason: input.reason,
        client: "Human operator",
        ttl_seconds: input.ttlSeconds,
        argv: input.argv,
        cwd: input.cwd,
        file_env: "CB_CREDENTIAL_FILE",
      },
      origin,
      consumerEnvironment,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else await broker.decide(request.request_id, true);
    return await completed;
  } finally {
    value = undefined;
    signal?.removeEventListener("abort", abort);
    try {
      await broker.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
