import { join } from "node:path";
import { createRequire } from "node:module";

// External dependencies load from disk in Node single-executable distributions.
const { z } = createRequire(import.meta.url)("zod");

export const DEFAULT_RUNTIME = join("/tmp", `ai-os-credentials-${process.getuid?.() ?? "user"}`);
export const GUIDANCE =
  "Sensitive credential file: pass its path to the intended program. Do not read, cat, print, log, copy, commit, or send its contents to an LLM. Release promptly. Expiry deletes the path; it cannot revoke copies already read.";
export function siteHost(value) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) ||
    url.hostname
      .split(".")
      .some(
        (label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
      ) ||
    url.hostname.endsWith(".")
  )
    throw new Error("Invalid site");
  return url.hostname;
}
export const requestSchema = z
  .object({
    kind: z.enum(["file", "exec"]).default("file"),
    item_id: z.string().uuid().optional(),
    site: z
      .string()
      .max(253)
      .transform((value, context) => {
        try {
          return siteHost(value);
        } catch {
          context.addIssue({
            code: "custom",
            message: "Provide a site hostname or HTTP(S) origin.",
          });
          return z.NEVER;
        }
      })
      .optional(),
    label: z.string().trim().min(1).max(120),
    field: z.enum(["password", "username", "login"]).default("password"),
    reason: z.string().trim().min(1).max(500),
    client: z.string().trim().min(1).max(120).default("unspecified client"),
    ttl_seconds: z.number().int().min(5).max(300).default(60),
    argv: z
      .array(
        z
          .string()
          .max(2048)
          .refine((value) => !value.includes("\0")),
      )
      .min(1)
      .max(64)
      .optional(),
    cwd: z.string().max(2048).optional(),
    file_env: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!!value.item_id === !!value.site)
      context.addIssue({ code: "custom", message: "Provide exactly one item UUID or site." });
    if (value.kind === "exec") {
      if (
        !value.argv?.[0]?.startsWith("/") ||
        !value.cwd?.startsWith("/") ||
        value.cwd.includes("\0") ||
        !value.file_env ||
        ["PATH", "HOME", "NODE_OPTIONS", "NODE_PATH", "BW_SESSION", "BW_PASSWORD"].includes(
          value.file_env,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Exec requires an absolute executable, working directory, and a dedicated file environment variable.",
        });
      }
    } else if (value.argv || value.cwd || value.file_env) {
      context.addIssue({
        code: "custom",
        message: "File leases cannot specify a command.",
      });
    }
  });

export class BrokerError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseRequest(input) {
  const result = requestSchema.safeParse(input);
  if (!result.success)
    throw new BrokerError(
      "Invalid request: provide exactly one item UUID or site, label, reason, field, and TTL of 5–300 seconds. Exec also requires an absolute executable, cwd, and dedicated file environment variable.",
      400,
      "invalid_request",
    );
  return result.data;
}
