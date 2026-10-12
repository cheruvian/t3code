import { execFile } from "node:child_process";
import { BrokerError } from "./common.js";

// Caller-controlled text is data in argv, never interpolated into executable code.
const script = `function run(argv) {
  var payload = JSON.parse(argv[0]);
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.activate();
  var selected = payload.choices[0];
  if (payload.choices.length > 1) {
    var choice = app.chooseFromList(payload.choices.map(function(c) { return c.label; }), {
      withTitle: "Credential Broker · Choose login",
      withPrompt: "Requested site: " + payload.site + "\\nSelect a login, then review its use.",
      multipleSelectionsAllowed: false, emptySelectionAllowed: false,
      okButtonName: "Review login", cancelButtonName: "Deny"
    });
    if (choice === false) return JSON.stringify({ approve: false });
    selected = payload.choices.filter(function(c) { return c.label === choice[0]; })[0];
  }
  var result = app.displayDialog(payload.details + "\\n\\nSelected vault login:\\n" + selected.label, {
    withTitle: "Credential Broker · Approve access",
    buttons: payload.alwaysAvailable ? ["Deny", "Allow once", "Always allow"] : ["Deny", "Approve"], defaultButton: "Deny", cancelButton: "Deny",
    withIcon: "caution"
  });
  return JSON.stringify({ approve: result.buttonReturned !== "Deny", always: result.buttonReturned === "Always allow", item_id: selected.item_id });
}`;

export function approvalPayload(request) {
  const choices = (
    request.candidates ?? [{ item_id: request.item_id, name: "Direct item request", hosts: [] }]
  ).map((candidate, index) => ({
    item_id: candidate.item_id,
    label: `${index + 1}. ${candidate.name} · ${candidate.hosts.join(", ")}\n${candidate.item_id}`,
  }));
  const details = [
    `Site: ${request.site ?? "Direct vault item"}`,
    `Client claim: ${request.client}`,
    `Label claim: ${request.label}`,
    `Fields: ${request.field === "login" ? "username and password (JSON file)" : request.field}`,
    `Purpose claim: ${request.reason}`,
    `File lifetime: ${request.ttl_seconds} seconds after delivery`,
    ...(request.kind === "exec"
      ? [
          "Operation: run command, discard stdout/stderr",
          `Executable: ${request.argv[0]}`,
          `Arguments (JSON): ${JSON.stringify(request.argv.slice(1))}`,
          `Working directory: ${request.cwd}`,
          `File path variable: ${request.file_env}`,
        ]
      : ["Operation: deliver temporary file"]),
    "Approve only the intended login and command. The program can read/copy the file. Expiry cannot revoke copies.",
  ].join("\n\n");
  if (details.length > 8000) throw new BrokerError("Request is too large for native review.");
  return { site: request.site, details, choices, alwaysAvailable: request.kind === "exec" };
}

export async function nativeApproval(request, { signal } = {}) {
  if (process.platform !== "darwin") throw new BrokerError("Native approval requires macOS.");
  const payload = approvalPayload(request);
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, JSON.stringify(payload)],
      {
        signal,
        timeout: Math.max(1, request.approval_deadline - Date.now()),
        maxBuffer: 64 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      },
      (error, stdout, stderr) => {
        if (error) {
          if (/\(-128\)/.test(stderr)) return resolve({ approve: false });
          return reject(new BrokerError("Native approval failed or timed out; no access granted."));
        }
        try {
          const result = JSON.parse(stdout);
          if (
            typeof result.approve !== "boolean" ||
            (result.approve && !payload.choices.some((c) => c.item_id === result.item_id))
          )
            throw new Error();
          resolve(result);
        } catch {
          reject(new BrokerError("Invalid native approval response; no access granted."));
        }
      },
    );
  });
}
