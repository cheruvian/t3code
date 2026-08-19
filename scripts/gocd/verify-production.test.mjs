import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { verifyProduction } from "./verify-production.mjs";

const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } = NodeFS;
const { platform, tmpdir } = NodeOS;
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
  writeFixture(electronExecutablePath(release));
}

function electronExecutablePath(release) {
  const dist = join(release, "apps", "desktop", "node_modules", "electron", "dist");
  return platform() === "darwin"
    ? join(dist, "Electron.app", "Contents", "MacOS", "Electron")
    : join(dist, platform() === "win32" ? "electron.exe" : "electron");
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
          birthToken: "2026-08-09T19:59:59.000Z",
          cwd: selectedReleaseA,
          command: [
            electronExecutablePath(selectedReleaseA),
            join(selectedReleaseA, "apps", "server", "dist", "bin.mjs"),
            "--bootstrap-fd",
            "3",
          ],
          listenerPids: [oldPid],
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
      previousRuntimeIdentity: {
        pid: runtimePid,
        startedAt: "2026-08-09T19:58:00.000Z",
      },
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
          birthToken: "2026-08-09T19:59:59.000Z",
          cwd: selectedReleaseC,
          command: [electronExecutablePath(selectedReleaseC), serverEntry, "--bootstrap-fd", "3"],
          listenerPids: [runtimePid],
        };
      },
    });

    expect({ result, inspections, requests }).toEqual({
      result: { release: selectedReleaseC, pid: runtimePid, sha: shaC },
      inspections: [
        [runtimePid, 17774],
        [runtimePid, 17774],
      ],
      requests: ["http://127.0.0.1:17774/"],
    });

    await expect(
      verifyProduction({
        runtimeRoot,
        expectedRelease: selectedReleaseC,
        expectedSha: shaC,
        launchedAfter: Date.parse("2026-08-09T19:59:59.000Z"),
        fetchImpl: async () => ({ ok: true, status: 200 }),
        inspectProcess: () => ({
          pid: runtimePid,
          alive: true,
          birthToken: "2026-08-09T19:59:59.000Z",
          cwd: selectedReleaseC,
          command: [
            electronExecutablePath(selectedReleaseC),
            serverEntry,
            "--bootstrap-fd",
            "3",
            "--unexpected",
          ],
          listenerPids: [runtimePid],
        }),
      }),
    ).rejects.toThrow(/did not launch/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// macOS runs the backend from the branded bundle electron-launcher.mjs builds,
// whose Electron is a copy of the packaged binary. Verifying only the packaged
// path reported a healthy production backend as "did not launch <entry>".
const itMac = platform() === "darwin" ? it : it.skip;

itMac("accepts a backend launched from the release's branded runtime bundle", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-production-verifier-branded-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const shaC = "c".repeat(40);
  const releaseC = join(productionRoot, "releases", shaC);
  const runtimePid = 636_363;

  try {
    createCompleteRelease(releaseC, shaC);
    const brandedExecutable = join(
      releaseC,
      "apps",
      "desktop",
      ".electron-runtime",
      "T3 Code (Alpha).app",
      "Contents",
      "MacOS",
      "Electron",
    );
    writeFixture(brandedExecutable);
    symlinkSync(releaseC, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: runtimePid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-09T20:00:00.000Z",
      })}\n`,
    );

    const selectedReleaseC = realpathSync(releaseC);
    const serverEntry = join(selectedReleaseC, "apps", "server", "dist", "bin.mjs");
    const brandedForSelected = join(
      selectedReleaseC,
      "apps",
      "desktop",
      ".electron-runtime",
      "T3 Code (Alpha).app",
      "Contents",
      "MacOS",
      "Electron",
    );

    const result = await verifyProduction({
      runtimeRoot,
      expectedRelease: selectedReleaseC,
      expectedSha: shaC,
      launchedAfter: Date.parse("2026-08-09T19:59:59.000Z"),
      fetchImpl: async () => ({ ok: true, status: 200 }),
      inspectProcess: () => ({
        pid: runtimePid,
        alive: true,
        birthToken: "2026-08-09T19:59:59.000Z",
        cwd: selectedReleaseC,
        command: [brandedForSelected, serverEntry, "--bootstrap-fd", "3"],
        listenerPids: [runtimePid],
      }),
    });

    expect(result).toEqual({ release: selectedReleaseC, pid: runtimePid, sha: shaC });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects HTTP success when listener ownership changes during verification", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-production-verifier-handoff-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "c".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const runtimePid = 626_262;

  try {
    createCompleteRelease(release, sha);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: runtimePid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-09T20:00:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const command = [
      electronExecutablePath(selectedRelease),
      join(selectedRelease, "apps/server/dist/bin.mjs"),
      "--bootstrap-fd",
      "3",
    ];
    let inspection = 0;

    await expect(
      verifyProduction({
        runtimeRoot,
        expectedRelease: selectedRelease,
        expectedSha: sha,
        launchedAfter: Date.parse("2026-08-09T19:59:59.000Z"),
        fetchImpl: async () => ({ ok: true, status: 200 }),
        inspectProcess: () => ({
          pid: runtimePid,
          alive: true,
          birthToken: "2026-08-09T19:59:59.000Z",
          cwd: selectedRelease,
          command,
          listenerPids: inspection++ === 0 ? [runtimePid] : [runtimePid + 1],
        }),
      }),
    ).rejects.toThrow(/ownership changed during verification/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
