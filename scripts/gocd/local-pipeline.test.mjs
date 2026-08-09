import { assert, expect, it } from "@effect/vitest";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function writeFixture(path, contents = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createCompleteRelease(release, sha) {
  writeFixture(join(release, "manifest.json"), `${JSON.stringify({ sha })}\n`);
  writeFixture(join(release, "apps", "desktop", "scripts", "start-electron.mjs"));
  writeFixture(join(release, "apps", "desktop", "node_modules", "electron", "package.json"));
  writeFixture(join(release, "apps", "desktop", "dist-electron", "main.cjs"));
  writeFixture(join(release, "apps", "server", "dist", "bin.mjs"));
  writeFixture(join(release, "assets", "dev", "blueprint-macos-1024.png"));
  writeFixture(join(release, "assets", "prod", "black-macos-1024.png"));
}

it("restores the running release when the replacement cannot launch", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const stagingRoot = join(runtimeRoot, "staging");
  const oldRelease = join(stagingRoot, "releases", "old-sha");
  const nextRelease = join(stagingRoot, "releases", "next-sha");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(oldRelease, "old-sha");
    createCompleteRelease(nextRelease, "next-sha");
    writeFixture(join(artifactRoot, "manifest.json"), '{"sha":"next-sha"}\n');
    symlinkSync(oldRelease, join(stagingRoot, "current"));

    const { deploy } = await import("./local-pipeline.mjs");
    const launches = [];
    const restoredRelease = realpathSync(oldRelease);
    await expect(
      deploy("staging", {
        launch: (_name, _paths, release) => {
          launches.push(release);
          if (release === nextRelease) throw new Error("simulated launch failure");
        },
        waitUntilReady: () => undefined,
      }),
    ).rejects.toThrow("simulated launch failure");

    assert.deepStrictEqual(launches, [nextRelease, restoredRelease]);
    assert.equal(realpathSync(join(stagingRoot, "current")), restoredRelease);
    assert.equal(realpathSync(join(stagingRoot, "previous")), restoredRelease);
    assert.equal(readlinkSync(join(stagingRoot, "current")), restoredRelease);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
