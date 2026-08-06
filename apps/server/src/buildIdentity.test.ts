import { describe, expect, it } from "vite-plus/test";

import { normalizeT3CodeCommit, t3CodeCommitsMatch } from "./buildIdentity.ts";

describe("normalizeT3CodeCommit", () => {
  it("normalizes exact source revisions", () => {
    expect(normalizeT3CodeCommit(" A2CA89AA10F13A2222E08AFD98C66285121D5BA2 ")).toBe(
      "a2ca89aa10f13a2222e08afd98c66285121d5ba2",
    );
  });

  it("matches abbreviated and full revisions", () => {
    expect(t3CodeCommitsMatch("a2ca89aa10f1", "a2ca89aa10f13a2222e08afd98c66285121d5ba2")).toBe(
      true,
    );
    expect(t3CodeCommitsMatch("a2ca89aa10f1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
      false,
    );
  });

  it("rejects tags and unknown revisions", () => {
    expect(normalizeT3CodeCommit("v1.2.3")).toBeNull();
    expect(normalizeT3CodeCommit("unknown")).toBeNull();
  });
});
