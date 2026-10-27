import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "one link_pull_request per PR");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(instructions, "Never wait with sleep");
    assert.include(instructions, "call unwatch_pull_request");
  });

  it("appends custom instructions when provided", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      customInstructions: "Always write tests.",
    });
    expect(instructions).toContain(
      "<user_custom_instructions>\nAlways write tests.\n</user_custom_instructions>",
    );
  });

  it("advertises the environment skill when its path is provided", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      t3CodeProjectDir: "/t3-home/t3code",
    });
    expect(instructions).toContain('name="t3-cli-api"');
    expect(instructions).toContain("/t3-home/t3code/.agents/skills/t3-cli-api/SKILL.md");
  });

  it.each([undefined, "", "   "])("omits the custom instructions block for %s", (value) => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", customInstructions: value });
    expect(instructions).not.toContain("user_custom_instructions");
  });
});
