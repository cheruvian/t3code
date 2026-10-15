import { EnvironmentId, ProjectId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import { v2Project, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

describe("built-in helper project identity", () => {
  it("follows the advertised helper root as config arrives and changes, preserving project IDs", () => {
    const environmentId = EnvironmentId.make("environment");
    const helperRoot = "/runtime/home/t3code";
    const helper = { ...v2Project, title: "T3 Code", workspaceRoot: helperRoot };
    const source = { ...v2Project, id: ProjectId.make("source"), workspaceRoot: "/work/t3code" };
    const config = Atom.make<ServerConfig | null>(null);
    const projects = createEnvironmentProjectAtoms({
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      snapshotAtom: () => Atom.make({ ...v2ShellSnapshot, projects: [helper, source] }),
      serverConfigValueAtom: () => config,
    });
    const registry = AtomRegistry.make();
    const helperAtom = projects.projectAtom({ environmentId, projectId: helper.id });
    const sourceAtom = projects.projectAtom({ environmentId, projectId: source.id });
    const stop = registry.subscribe(helperAtom, () => {});
    try {
      expect(registry.get(helperAtom)?.isT3ChatHelper).toBe(false);
      registry.set(config, {
        environment: { t3CodeProjectRoot: `${helperRoot}/` },
      } as ServerConfig);
      const identified = registry.get(helperAtom);
      expect(identified?.isT3ChatHelper).toBe(true);
      expect(identified?.id).toBe(helper.id);
      expect(identified?.environmentId).toBe(environmentId);
      expect(registry.get(sourceAtom)?.isT3ChatHelper).toBe(false);
      registry.set(config, {
        environment: { t3CodeProjectRoot: source.workspaceRoot },
      } as ServerConfig);
      expect(registry.get(helperAtom)?.isT3ChatHelper).toBe(false);
      expect(registry.get(sourceAtom)?.isT3ChatHelper).toBe(true);
    } finally {
      stop();
      registry.dispose();
    }
  });
});
