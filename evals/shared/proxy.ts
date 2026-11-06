// Eval-only credentials for an explicitly selected Codex session or configured proxy.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);
/** An explicit eval profile uses ChatGPT auth; otherwise retain the configured proxy. */
export const proxyConfig = () => {
  const home = process.env.T3_EVAL_CODEX_HOME;
  if (home) {
    // Keep auth parse errors and their source text out of eval logs.
    try {
      const auth = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "auth.json"), "utf8"));
      const token = auth.tokens?.access_token;
      const account = auth.tokens?.account_id;
      if (typeof token === "string" && token && typeof account === "string" && account) {
        return {
          url: "https://chatgpt.com/backend-api/codex",
          headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account },
        };
      }
    } catch {
      // Report only a fixed message: auth.json contains credentials.
    }
    throw new Error("Selected Codex profile requires an existing ChatGPT session");
  }
  return decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          `
import json, os, pathlib, tomllib
home = pathlib.Path.home() / '.codex'
p = tomllib.loads((home / 'config.toml').read_text())['model_providers']['vibeproxy']
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
};
