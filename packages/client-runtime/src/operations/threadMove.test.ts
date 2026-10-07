import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadMoveImportReceipt,
  type ThreadMovePortableManifest,
  type ThreadMoveResponse,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  compatibleThreadMoveProvider,
  runThreadMoveUndoSaga,
  runThreadMoveSaga,
  type ThreadMovePorts,
} from "./threadMove.ts";

const input = {
  threadId: ThreadId.make("thread"),
  moveId: "move",
  destinationEnvironmentId: EnvironmentId.make("destination"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("codex"),
};
const manifest: ThreadMovePortableManifest = {
  version: 1,
  moveId: input.moveId,
  threadId: input.threadId,
  sourceEnvironmentId: EnvironmentId.make("source"),
  destinationEnvironmentId: input.destinationEnvironmentId,
  repositoryCanonicalKey: "example.com/repository",
  providerDriver: ProviderDriverKind.make("codex"),
  nativeThreadId: "same-native-id",
  worktreeRelativePath: "worktree",
  branch: "feature",
  headCommit: "a".repeat(40),
  ignoredFilesIncluded: false,
  parts: [{ kind: "working_tree", sha256: "b".repeat(64), sizeBytes: 12 }],
};
const receipt: ThreadMoveImportReceipt = {
  version: 1,
  importId: input.moveId,
  moveId: input.moveId,
  threadId: input.threadId,
  destinationEnvironmentId: input.destinationEnvironmentId,
  providerDriver: manifest.providerDriver,
  nativeThreadId: manifest.nativeThreadId,
  activatedAt: "2026-10-05T12:00:00.000Z",
  manifestSha256: "c".repeat(64),
};

function fixture(options?: {
  uploadFailure?: boolean;
  lostCommitAck?: boolean;
  lostActivateAck?: boolean;
  failedImport?: boolean;
  rejectedImportWhileUploading?: boolean;
}) {
  let sourceState: ThreadMoveResponse["state"] = "idle",
    destinationState: ThreadMoveResponse["state"] = "idle",
    offset = 0;
  let commitCount = 0,
    finalizeCount = 0,
    abortCount = 0,
    cancellationCount = 0;
  const cancellation = {
    moveId: input.moveId,
    threadId: input.threadId,
    destinationEnvironmentId: input.destinationEnvironmentId,
    manifestSha256: receipt.manifestSha256,
  };
  const ports: ThreadMovePorts = {
    source: async (request) => {
      if (request.action === "export") {
        if (sourceState === "idle") sourceState = "fenced";
        return { state: sourceState, manifest, relativeUrl: "/download" };
      }
      if (request.action === "activate") {
        sourceState = "activating";
        if (options?.lostActivateAck) {
          options.lostActivateAck = false;
          throw new Error("activation acknowledgement lost");
        }
        return { state: sourceState };
      }
      if (request.action === "finalize") {
        expect(destinationState).toBe("committed");
        finalizeCount++;
        sourceState = "moved";
        return { state: sourceState };
      }
      if (request.action === "abort") {
        expect(sourceState).not.toBe("activating");
        abortCount++;
        sourceState = "idle";
        return { state: "cancelled" };
      }
      if (request.action === "recover") {
        expect(destinationState).toBe("cancelled");
        sourceState = "idle";
        return { state: "cancelled" };
      }
      throw new Error("unexpected source action");
    },
    destination: async (request) => {
      if (request.action === "status")
        return {
          state: destinationState,
          ...(destinationState === "committed" ? { receipt } : {}),
          ...(destinationState === "cancelled" ? { cancellation } : {}),
        };
      if (request.action === "begin") {
        destinationState = "uploading";
        return { state: destinationState, offset, relativeUrl: "/upload" };
      }
      if (request.action === "cancel") {
        if (destinationState === "committed") return { state: destinationState, receipt };
        cancellationCount++;
        destinationState = "cancelled";
        return { state: destinationState, cancellation };
      }
      if (request.action === "commit") {
        expect(sourceState).toBe("activating");
        expect(offset).toBe(12);
        if (options?.failedImport) {
          destinationState = "cancelled";
          throw new Error("native load rejected");
        }
        if (options?.rejectedImportWhileUploading) {
          throw new Error("provider compatibility changed");
        }
        commitCount++;
        destinationState = "committed";
        if (options?.lostCommitAck) {
          options.lostCommitAck = false;
          throw new Error("commit acknowledgement lost");
        }
        return { state: destinationState, receipt };
      }
      throw new Error("unexpected destination action");
    },
    transfer: async (_source, _destination, start) => {
      if (options?.uploadFailure) throw new Error("network failure");
      expect(start).toBe(offset);
      offset = Math.min(12, start + 4);
      return offset;
    },
  };
  return {
    ports,
    state: () => ({
      sourceState,
      destinationState,
      commitCount,
      finalizeCount,
      abortCount,
      cancellationCount,
    }),
  };
}

describe("environment thread move", () => {
  it("settles the source only after all bytes and a durable destination receipt", async () => {
    const f = fixture();
    await runThreadMoveSaga(input, f.ports);
    expect(f.state()).toEqual({
      sourceState: "moved",
      destinationState: "committed",
      commitCount: 1,
      finalizeCount: 1,
      abortCount: 0,
      cancellationCount: 0,
    });
  });
  it("unfences after a pre-activation failure", async () => {
    const f = fixture({ uploadFailure: true });
    await expect(runThreadMoveSaga(input, f.ports)).rejects.toThrow("network failure");
    expect(f.state()).toEqual({
      sourceState: "idle",
      destinationState: "cancelled",
      commitCount: 0,
      finalizeCount: 0,
      abortCount: 1,
      cancellationCount: 1,
    });
  });
  it("reconciles a lost commit acknowledgement without a second import or unsafe abort", async () => {
    const f = fixture({ lostCommitAck: true });
    await expect(runThreadMoveSaga(input, f.ports)).rejects.toThrow("commit acknowledgement lost");
    expect(f.state().sourceState).toBe("activating");
    expect(f.state().finalizeCount).toBe(0);
    expect(f.state().destinationState).toBe("committed");
    expect(f.state().cancellationCount).toBe(0);
    await runThreadMoveSaga(input, f.ports);
    expect(f.state()).toEqual({
      sourceState: "moved",
      destinationState: "committed",
      commitCount: 1,
      finalizeCount: 1,
      abortCount: 0,
      cancellationCount: 0,
    });
  });
  it("recovers a lost activation acknowledgement only after destination cancellation", async () => {
    const f = fixture({ lostActivateAck: true });
    await expect(runThreadMoveSaga(input, f.ports)).rejects.toThrow(
      "activation acknowledgement lost",
    );
    expect(f.state().sourceState).toBe("idle");
    expect(f.state().destinationState).toBe("cancelled");
    expect(f.state().abortCount).toBe(0);
    expect(f.state().cancellationCount).toBe(1);
    expect(f.state().finalizeCount).toBe(0);
    expect(f.state().commitCount).toBe(0);
  });
  it("uses a confirmed destination cancellation to recover a failed native import", async () => {
    const f = fixture({ failedImport: true });
    await expect(runThreadMoveSaga(input, f.ports)).rejects.toThrow("native load rejected");
    expect(f.state().sourceState).toBe("idle");
    expect(f.state().finalizeCount).toBe(0);
  });
  it("cancels an upload rejected after source activation before recovering the source", async () => {
    const f = fixture({ rejectedImportWhileUploading: true });
    await expect(runThreadMoveSaga(input, f.ports)).rejects.toThrow(
      "provider compatibility changed",
    );
    expect(f.state()).toEqual({
      sourceState: "idle",
      destinationState: "cancelled",
      commitCount: 0,
      finalizeCount: 0,
      abortCount: 0,
      cancellationCount: 1,
    });
  });
  it("requires both capability support and an authenticated compatible provider", () => {
    const config = {
      environment: { capabilities: { threadEnvironmentMove: true } },
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
        },
      ],
    } as unknown as ServerConfig;
    expect(compatibleThreadMoveProvider(config, "codex")).toBeUndefined();
    expect(compatibleThreadMoveProvider(config, "claudeAgent")?.instanceId).toBe("claudeAgent");
    expect(compatibleThreadMoveProvider(undefined, "claudeAgent")).toBeUndefined();
    expect(
      compatibleThreadMoveProvider(
        { ...config, providers: [{ ...config.providers[0]!, installed: false }] },
        "claudeAgent",
      ),
    ).toBeUndefined();
  });
});

it("undo retries a lost destination acknowledgement without reactivating the destination", async () => {
  const calls: string[] = [];
  let cancelled = false;
  const cancellation = {
    moveId: input.moveId,
    threadId: input.threadId,
    destinationEnvironmentId: input.destinationEnvironmentId,
    manifestSha256: receipt.manifestSha256,
  };
  const ports: Pick<ThreadMovePorts, "source" | "destination"> = {
    source: async (request) => {
      calls.push(`source:${request.action}`);
      return { state: "moved" };
    },
    destination: async (request) => {
      calls.push(`destination:${request.action}`);
      if (request.action === "undo") {
        cancelled = true;
        throw new Error("undo acknowledgement lost");
      }
      return cancelled ? { state: "cancelled", cancellation } : { state: "committed", receipt };
    },
  };
  const undo = {
    threadId: input.threadId,
    moveId: input.moveId,
    sourceEnvironmentId: EnvironmentId.make("source"),
    destinationEnvironmentId: input.destinationEnvironmentId,
  };
  await expect(runThreadMoveUndoSaga(undo, ports)).rejects.toThrow(/acknowledgement lost/);
  await runThreadMoveUndoSaga(undo, ports);
  expect(calls.filter((call) => call === "destination:undo")).toHaveLength(1);
  expect(calls.at(-1)).toBe("source:restore");
});

it("reports export, byte progress, activation and final confirmation in order", async () => {
  const progress: Array<import("./threadMove.ts").ThreadMoveProgress> = [];
  const f = fixture();
  await runThreadMoveSaga({ ...input, onProgress: (state) => progress.push(state) }, f.ports);
  expect(progress.map((state) => state.phase)).toEqual([
    "checking",
    "exporting",
    "uploading",
    "uploading",
    "uploading",
    "uploading",
    "activating",
    "finalizing",
  ]);
  expect(progress.filter((state) => state.phase === "uploading")).toEqual([
    { phase: "uploading", transferredBytes: 0, totalBytes: 12 },
    { phase: "uploading", transferredBytes: 4, totalBytes: 12 },
    { phase: "uploading", transferredBytes: 8, totalBytes: 12 },
    { phase: "uploading", transferredBytes: 12, totalBytes: 12 },
  ]);
});

it("reports reconciliation on failure without letting presentation errors break recovery", async () => {
  const phases: string[] = [];
  const f = fixture({ uploadFailure: true });
  await expect(
    runThreadMoveSaga(
      {
        ...input,
        onProgress: (state) => {
          phases.push(state.phase);
          throw new Error("unmounted UI");
        },
      },
      f.ports,
    ),
  ).rejects.toThrow();
  expect(phases.at(-1)).toBe("reconciling");
});

it("negotiates the destination base while retaining the full-export fallback for older servers", async () => {
  const f = fixture();
  const base = "d".repeat(40);
  const exported: Array<import("@t3tools/contracts").ThreadMoveRequest> = [];
  await runThreadMoveSaga(input, {
    ...f.ports,
    destination: async (request) => {
      const result = await f.ports.destination(request);
      return request.action === "status" ? { ...result, repositoryHeadCommit: base } : result;
    },
    source: async (request) => {
      if (request.action === "export") exported.push(request);
      return f.ports.source(request);
    },
  });
  expect(exported[0]).toMatchObject({ action: "export", destinationHeadCommit: base });
});
