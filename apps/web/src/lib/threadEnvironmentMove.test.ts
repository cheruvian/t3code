import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getAtom: vi.fn(),
  readProjects: vi.fn(),
  readThreadShell: vi.fn(),
  runAtomCommand: vi.fn(),
  threadMoveDestinations: vi.fn(),
  threadMoveUndoParticipants: vi.fn(),
  toast: vi.fn(),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  waitForThreadShell: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/operations")>()),
  threadMoveDestinations: mocks.threadMoveDestinations,
  threadMoveUndoParticipants: mocks.threadMoveUndoParticipants,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: mocks.getAtom },
}));

vi.mock("../state/entities", () => ({
  readProjects: mocks.readProjects,
  readThreadShell: mocks.readThreadShell,
  waitForThreadShell: mocks.waitForThreadShell,
}));

vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environment-server-configs"),
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    move: Symbol("thread-move"),
    undoMove: Symbol("thread-move-undo"),
  },
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.toast, update: mocks.updateToast, close: mocks.closeToast },
}));

import { moveThreadToEnvironment, undoThreadEnvironmentMove } from "./threadEnvironmentMove";

const sourceEnvironmentId = EnvironmentId.make("source-environment");
const destinationEnvironmentId = EnvironmentId.make("destination-environment");
const threadId = ThreadId.make("thread-1");
const sourceRef = { environmentId: sourceEnvironmentId, threadId };
const destinationRef = { environmentId: destinationEnvironmentId, threadId };

function delayedShellPublication() {
  let publish!: (ready: boolean) => void;
  const published = new Promise<boolean>((resolve) => {
    publish = resolve;
  });
  return { published, publish };
}

describe("thread environment move navigation readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAtom.mockReturnValue(new Map());
    mocks.readProjects.mockReturnValue([]);
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it("waits for delayed source shell publication before releasing undo navigation", async () => {
    const publication = delayedShellPublication();
    mocks.threadMoveUndoParticipants.mockReturnValue({
      threadId,
      moveId: "move-1",
      sourceEnvironmentId,
      destinationEnvironmentId,
    });
    mocks.waitForThreadShell.mockReturnValue(publication.published);

    const undo = undoThreadEnvironmentMove(destinationRef, {} as never);
    let released = false;
    void undo.then(() => {
      released = true;
    });
    await Promise.resolve();

    expect(mocks.waitForThreadShell).toHaveBeenCalledWith(sourceRef);
    expect(released).toBe(false);

    publication.publish(true);

    await expect(undo).resolves.toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Thread restored to its source environment",
    });
  });

  it("waits for the destination shell before releasing move navigation", async () => {
    const publication = delayedShellPublication();
    mocks.readThreadShell.mockReturnValue({ environmentMove: null });
    mocks.threadMoveDestinations.mockReturnValue([
      {
        environmentId: destinationEnvironmentId,
        projectId: "project-1",
        instanceId: "instance-1",
        label: "Destination",
      },
    ]);
    mocks.waitForThreadShell.mockReturnValue(publication.published);

    const move = moveThreadToEnvironment(sourceRef, destinationEnvironmentId);
    let released = false;
    void move.then(() => {
      released = true;
    });
    await Promise.resolve();

    expect(mocks.waitForThreadShell).toHaveBeenCalledWith(destinationRef);
    expect(released).toBe(false);

    publication.publish(true);

    await expect(move).resolves.toBe(true);
  });

  it("reports completed undo awaiting refresh without releasing navigation", async () => {
    mocks.threadMoveUndoParticipants.mockReturnValue({
      threadId,
      moveId: "move-1",
      sourceEnvironmentId,
      destinationEnvironmentId,
    });
    mocks.waitForThreadShell.mockResolvedValue(false);

    await expect(undoThreadEnvironmentMove(destinationRef, {} as never)).resolves.toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "warning",
      title: "Thread restored; refresh needed",
      description:
        "The undo completed, but the source thread has not appeared yet. Refresh before opening it.",
    });
  });
});

it("shows persistent progress and rejects duplicate moves while export is pending", async () => {
  let finish!: (value: { _tag: "Success" }) => void;
  const pending = new Promise<{ _tag: "Success" }>((resolve) => {
    finish = resolve;
  });
  mocks.readThreadShell.mockReturnValue({ environmentMove: null });
  mocks.threadMoveDestinations.mockReturnValue([
    {
      environmentId: destinationEnvironmentId,
      projectId: "project",
      instanceId: "instance",
      label: "Destination",
    },
  ]);
  mocks.runAtomCommand.mockImplementation(async (_registry, _command, args) => {
    args.input.onProgress({
      phase: "uploading",
      transferredBytes: 5_000_000,
      totalBytes: 10_000_000,
    });
    return pending;
  });
  mocks.waitForThreadShell.mockResolvedValue(true);
  mocks.toast.mockReturnValue("progress-toast");
  const move = moveThreadToEnvironment(sourceRef, destinationEnvironmentId);
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "loading", timeout: 0 }),
  );
  expect(mocks.updateToast).toHaveBeenCalledWith("progress-toast", {
    description: "Transferring 5.0 / 10.0 MB (50%)",
  });
  await expect(moveThreadToEnvironment(sourceRef, destinationEnvironmentId)).resolves.toBe(false);
  expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
  finish({ _tag: "Success" });
  await expect(move).resolves.toBe(true);
  expect(mocks.closeToast).toHaveBeenCalledWith("progress-toast");
});
