// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../test-fixtures";
import { ThreadPrVisibilityContext } from "./thread-pr-visibility";

const harness = vi.hoisted(() => ({ active: 0, reads: 0 }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("@t3tools/client-runtime/state/pull-requests", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@t3tools/client-runtime/state/pull-requests")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const summaries = Atom.family((number: number) =>
    Atom.make((get) => {
      harness.active++;
      harness.reads++;
      get.addFinalizer(() => {
        harness.active--;
      });
      const summary: PullRequestSummary = {
        provider: SourceControlProviderKind.make("github"),
        projectId: ProjectId.make("project-test"),
        repository: "acme/project",
        number,
        title: `Change ${number}`,
        url: `https://github.com/acme/project/pull/${number}`,
        state: "open",
        headBranch: "feature",
        baseBranch: "main",
        updatedAt: "2026-10-15T00:00:00Z",
      };
      return AsyncResult.success(summary);
    }).pipe(Atom.setIdleTTL(0)),
  );
  return {
    ...original,
    createLinkedPullRequestSummaryAtomFamily: () => (target: { input: { number: number } }) =>
      summaries(target.input.number),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { useThreadPr } from "./use-thread-pr";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  appAtomRegistry.reset();
});

it("releases hidden PR queries, keeps the cached badge, and resumes when the screen returns", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const thread = makeThreadShellFixture({
    environmentId: EnvironmentId.make("visibility-test"),
    linkedPullRequest: {
      projectId: ProjectId.make("project-test"),
      repository: "acme/project",
      number: 42,
      url: "https://github.com/acme/project/pull/42",
    },
  });
  function Probe({ enabled, number }: { enabled: boolean; number: number }) {
    const selected = useMemo(
      () => ({ ...thread, linkedPullRequest: { ...thread.linkedPullRequest!, number } }),
      [number],
    );
    const pr = useThreadPr(selected, enabled);
    return <span>{pr?.label}</span>;
  }
  const container = document.createElement("div");
  root = createRoot(container);
  async function render(visible: boolean, enabled = true, number = 42) {
    await act(async () =>
      root!.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <ThreadPrVisibilityContext.Provider value={visible}>
            <Probe enabled={enabled} number={number} />
          </ThreadPrVisibilityContext.Provider>
        </RegistryContext.Provider>,
      ),
    );
  }
  await render(true);
  expect(container.textContent).toBe("42");
  expect(harness.active).toBe(1);
  await render(false);
  expect(harness.active).toBe(0);
  expect(container.textContent).toBe("42");
  await render(true);
  expect(harness.active).toBe(1);
  expect(harness.reads).toBe(2);
  expect(container.textContent).toBe("42");
  await render(true, false);
  expect(harness.active).toBe(0);
  expect(container.textContent).toBe("42");
  await render(false, true, 43);
  expect(container.textContent).toBe("");
  expect(harness.active).toBe(0);
  await render(true, true, 43);
  expect(container.textContent).toBe("43");
  expect(harness.active).toBe(1);
});
