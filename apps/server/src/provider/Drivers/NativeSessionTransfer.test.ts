// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, expect, it } from "vite-plus/test";

import {
  encodeClaudeProjectPath,
  exportNativeSession,
  installNativeSession,
} from "./NativeSessionTransfer.ts";

const tempDirectories: Array<string> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("NativeSessionTransfer", () => {
  it("moves the selected Claude dependency closure and remaps its project directory", async () => {
    const sourceHome = await temporaryDirectory("t3-claude-source-");
    const destinationHome = await temporaryDirectory("t3-claude-destination-");
    const payloadDirectory = await temporaryDirectory("t3-claude-payload-");
    const sourceCwd = await temporaryDirectory("t3-claude-source-cwd.with_punctuation-");
    const destinationCwd = await temporaryDirectory("t3-claude-destination-cwd.with_punctuation-");
    const sessionId = "claude-session-1";
    const sourceProject = NodePath.join(
      sourceHome,
      "projects",
      encodeClaudeProjectPath(await NodeFSP.realpath(sourceCwd)),
    );
    await NodeFSP.mkdir(sourceProject, { recursive: true });
    const selectedBytes = [
      JSON.stringify({ type: "user", sessionId, cwd: sourceCwd, message: { content: "hello" } }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        isSidechain: true,
        message: { content: "side" },
      }),
      JSON.stringify({ type: "system", sessionId, subtype: "compact_boundary" }),
    ].join("\n");
    await NodeFSP.writeFile(NodePath.join(sourceProject, `${sessionId}.jsonl`), selectedBytes);
    await NodeFSP.mkdir(NodePath.join(sourceProject, sessionId, "subagents"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(sourceProject, sessionId, "subagents", "agent-1.jsonl"),
      JSON.stringify({ sessionId, isSidechain: true }),
    );
    await NodeFSP.writeFile(
      NodePath.join(sourceProject, "other-session.jsonl"),
      "private-other-session",
    );
    await NodeFSP.writeFile(NodePath.join(sourceHome, "auth.json"), "private-credential");

    const archive = await exportNativeSession({
      driver: "claude",
      nativeThreadId: sessionId,
      sourceHomePath: sourceHome,
      sourceCwd,
      payloadDirectory,
    });

    assert.deepEqual(archive.files.map((file) => file.relativePath).toSorted(), [
      `${sessionId}.jsonl`,
      `${sessionId}/subagents/agent-1.jsonl`,
    ]);
    const rollback = await installNativeSession({
      archive,
      payloadDirectory,
      destinationHomePath: destinationHome,
      destinationCwd,
    });

    const installed = NodePath.join(
      destinationHome,
      "projects",
      encodeClaudeProjectPath(await NodeFSP.realpath(destinationCwd)),
      `${sessionId}.jsonl`,
    );
    assert.equal(await NodeFSP.readFile(installed, "utf8"), selectedBytes);
    assert.equal(
      await NodeFSP.readFile(
        NodePath.join(NodePath.dirname(installed), sessionId, "subagents", "agent-1.jsonl"),
        "utf8",
      ),
      JSON.stringify({ sessionId, isSidechain: true }),
    );
    await expect(NodeFSP.access(NodePath.join(destinationHome, "auth.json"))).rejects.toThrow();
    await expect(
      NodeFSP.access(NodePath.join(NodePath.dirname(installed), "other-session.jsonl")),
    ).rejects.toThrow();
    await rollback();
    await expect(NodeFSP.access(installed)).rejects.toThrow();
  });

  it("finds a Codex rollout by session_meta, preserves sidecars, and rejects collisions", async () => {
    const sourceHome = await temporaryDirectory("t3-codex-source-");
    const destinationHome = await temporaryDirectory("t3-codex-destination-");
    const payloadDirectory = await temporaryDirectory("t3-codex-payload-");
    const sessionId = "019fbbc1-b12c-7360-a685-28c181f0025f";
    const relativeDirectory = NodePath.join("sessions", "2026", "10", "05");
    const sessionDirectory = NodePath.join(sourceHome, relativeDirectory);
    await NodeFSP.mkdir(sessionDirectory, { recursive: true });
    const rolloutName = "rollout-2026-10-05T12-00-00-session.jsonl";
    const rolloutBytes = `${JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, cwd: "/source/worktree" },
    })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`;
    await NodeFSP.writeFile(NodePath.join(sessionDirectory, rolloutName), rolloutBytes);
    await NodeFSP.writeFile(NodePath.join(sessionDirectory, `${sessionId}.snapshot`), "sidecar");
    await NodeFSP.writeFile(NodePath.join(sessionDirectory, "unrelated.snapshot"), "other");
    await NodeFSP.writeFile(NodePath.join(sourceHome, "auth.json"), "private-credential");

    const archive = await exportNativeSession({
      driver: "codex",
      nativeThreadId: sessionId,
      sourceHomePath: sourceHome,
      sourceCwd: "/source/worktree",
      payloadDirectory,
    });

    assert.deepEqual(
      archive.files.map((file) => file.relativePath).toSorted(),
      [
        NodePath.join(relativeDirectory, rolloutName),
        NodePath.join(relativeDirectory, `${sessionId}.snapshot`),
      ].toSorted(),
    );
    await installNativeSession({
      archive,
      payloadDirectory,
      destinationHomePath: destinationHome,
      destinationCwd: "/destination/worktree",
    });
    assert.equal(
      await NodeFSP.readFile(
        NodePath.join(destinationHome, relativeDirectory, rolloutName),
        "utf8",
      ),
      rolloutBytes,
    );
    await expect(
      installNativeSession({
        archive,
        payloadDirectory,
        destinationHomePath: destinationHome,
        destinationCwd: "/destination/worktree",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("replaces an owned Codex rollout with a recoverable backup", async () => {
    const sourceHome = await temporaryDirectory("t3-codex-replace-source-");
    const destinationHome = await temporaryDirectory("t3-codex-replace-destination-");
    const payloadDirectory = await temporaryDirectory("t3-codex-replace-payload-");
    const replacementDirectory = await temporaryDirectory("t3-codex-replace-backup-");
    const sessionId = "019fbbc1-b12c-7360-a685-28c181f0025f";
    const relativeDirectory = NodePath.join("sessions", "2026", "10", "05");
    const rolloutName = `rollout-${sessionId}.jsonl`;
    const sourcePath = NodePath.join(sourceHome, relativeDirectory, rolloutName);
    const destinationPath = NodePath.join(destinationHome, relativeDirectory, rolloutName);
    await NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(destinationPath), { recursive: true });
    const incoming = `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\nnew\n`;
    await NodeFSP.writeFile(sourcePath, incoming);
    await NodeFSP.writeFile(destinationPath, "previous rollout bytes");
    const archive = await exportNativeSession({
      driver: "codex",
      nativeThreadId: sessionId,
      sourceHomePath: sourceHome,
      sourceCwd: "/source/worktree",
      payloadDirectory,
    });

    const rollback = await installNativeSession({
      archive,
      payloadDirectory,
      destinationHomePath: destinationHome,
      destinationCwd: "/destination/worktree",
      replacementDirectory,
    });
    assert.equal(await NodeFSP.readFile(destinationPath, "utf8"), incoming);
    assert.equal(
      await NodeFSP.readFile(
        NodePath.join(replacementDirectory, "native-0000.bin.previous"),
        "utf8",
      ),
      "previous rollout bytes",
    );
    await rollback();
    assert.equal(await NodeFSP.readFile(destinationPath, "utf8"), "previous rollout bytes");
  });

  it("rejects corrupt native payloads before creating destination files", async () => {
    const sourceHome = await temporaryDirectory("t3-native-source-");
    const destinationHome = await temporaryDirectory("t3-native-destination-");
    const payloadDirectory = await temporaryDirectory("t3-native-payload-");
    const sourceCwd = await temporaryDirectory("t3-native-source-cwd-");
    const destinationCwd = await temporaryDirectory("t3-native-destination-cwd-");
    const sessionId = "claude-corrupt";
    const projectDirectory = NodePath.join(
      sourceHome,
      "projects",
      encodeClaudeProjectPath(await NodeFSP.realpath(sourceCwd)),
    );
    await NodeFSP.mkdir(projectDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(projectDirectory, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", sessionId, cwd: sourceCwd }),
    );
    const archive = await exportNativeSession({
      driver: "claude",
      nativeThreadId: sessionId,
      sourceHomePath: sourceHome,
      sourceCwd,
      payloadDirectory,
    });
    await NodeFSP.appendFile(
      NodePath.join(payloadDirectory, archive.files[0]!.payloadPath),
      "tampered",
    );

    await expect(
      installNativeSession({
        archive,
        payloadDirectory,
        destinationHomePath: destinationHome,
        destinationCwd,
      }),
    ).rejects.toThrow(/integrity/);
    await expect(NodeFSP.access(NodePath.join(destinationHome, "projects"))).rejects.toThrow();
  });

  it("rejects a validly hashed payload whose native session id does not match", async () => {
    const sourceHome = await temporaryDirectory("t3-native-mismatch-source-");
    const destinationHome = await temporaryDirectory("t3-native-mismatch-destination-");
    const payloadDirectory = await temporaryDirectory("t3-native-mismatch-payload-");
    const sourceCwd = await temporaryDirectory("t3-native-mismatch-source-cwd-");
    const destinationCwd = await temporaryDirectory("t3-native-mismatch-destination-cwd-");
    const sessionId = "claude-original";
    const projectDirectory = NodePath.join(
      sourceHome,
      "projects",
      encodeClaudeProjectPath(await NodeFSP.realpath(sourceCwd)),
    );
    await NodeFSP.mkdir(projectDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(projectDirectory, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", sessionId, cwd: sourceCwd }),
    );
    const archive = await exportNativeSession({
      driver: "claude",
      nativeThreadId: sessionId,
      sourceHomePath: sourceHome,
      sourceCwd,
      payloadDirectory,
    });

    await expect(
      installNativeSession({
        archive: { ...archive, nativeThreadId: "claude-other" },
        payloadDirectory,
        destinationHomePath: destinationHome,
        destinationCwd,
      }),
    ).rejects.toThrow(/does not match/);
    await expect(NodeFSP.access(NodePath.join(destinationHome, "projects"))).rejects.toThrow();
  });
});
