import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { verifyProduction } from "./verify-production.mjs";

const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } = NodeFS;
const { tmpdir } = NodeOS;
const { dirname, join } = NodePath;

function writeFixture(path, contents = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createCompleteRelease(release, sha) {
  writeFixture(join(release, "manifest.json"), `${JSON.stringify({ sha })}\n`);
  writeFixture(join(release, "package.json"), "{}\n");
  writeFixture(join(release, "apps", "desktop", "scripts", "start-electron.mjs"));
  writeFixture(join(release, "apps", "desktop", "node_modules", "electron", "package.json"));
  writeFixture(join(release, "apps", "desktop", "dist-electron", "main.cjs"));
  writeFixture(join(release, "apps", "server", "dist", "bin.mjs"));
  writeFixture(join(release, "assets", "dev", "blueprint-macos-1024.png"));
  writeFixture(join(release, "assets", "prod", "black-macos-1024.png"));
}

it("rejects a healthy response served by an old production release", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-production-verifier-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseC = join(productionRoot, "releases", shaC);
  const oldPid = 424_242;

  try {
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseC, shaC);
    symlinkSync(releaseC, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: oldPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-09T20:00:00.000Z",
      })}\n`,
    );

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseC = realpathSync(releaseC);
    await expect(
      verifyProduction({
        runtimeRoot,
        expectedRelease: selectedReleaseC,
        expectedSha: shaC,
        fetchImpl: async () => ({ ok: true, status: 200 }),
        inspectProcess: () => ({
          pid: oldPid,
          alive: true,
          cwd: selectedReleaseA,
          command: [process.execPath, join(selectedReleaseA, "apps", "server", "dist", "bin.mjs")],
          listenerPid: oldPid,
        }),
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("accepts a healthy backend bound to the selected production release", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-production-verifier-match-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const shaC = "c".repeat(40);
  const releaseC = join(productionRoot, "releases", shaC);
  const runtimePid = 525_252;
  const runtimeStartedAt = "2026-08-09T20:00:00.000Z";

  try {
    createCompleteRelease(releaseC, shaC);
    symlinkSync(releaseC, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: runtimePid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: runtimeStartedAt,
      })}\n`,
    );

    const selectedReleaseC = realpathSync(releaseC);
    const serverEntry = join(selectedReleaseC, "apps", "server", "dist", "bin.mjs");
    const inspections = [];
    const requests = [];
    const result = await verifyProduction({
      runtimeRoot,
      expectedRelease: selectedReleaseC,
      expectedSha: shaC,
      previousRuntimePid: runtimePid - 1,
      launchedAfter: Date.parse("2026-08-09T19:59:59.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        return { ok: true, status: 200 };
      },
      inspectProcess: (pid, port) => {
        inspections.push([pid, port]);
        return {
          pid: runtimePid,
          alive: true,
          cwd: selectedReleaseC,
          command: [process.execPath, serverEntry],
          listenerPid: runtimePid,
        };
      },
    });

    expect({ result, inspections, requests }).toEqual({
      result: { release: selectedReleaseC, pid: runtimePid, sha: shaC },
      inspections: [[runtimePid, 17774]],
      requests: ["http://127.0.0.1:17774/"],
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
