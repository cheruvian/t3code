import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { electronDownloadArgs } from "./ensure-electron-runtime.mjs";

describe("Electron runtime download", () => {
  it("retries transient transfer failures within a bounded window", () => {
    assert.deepEqual(
      electronDownloadArgs("https://example.test/electron.zip", "/tmp/electron.zip"),
      [
        "-fsSL",
        "--retry",
        "5",
        "--retry-all-errors",
        "--retry-delay",
        "2",
        "--retry-max-time",
        "1200",
        "--connect-timeout",
        "30",
        "--max-time",
        "600",
        "--continue-at",
        "-",
        "https://example.test/electron.zip",
        "-o",
        "/tmp/electron.zip",
      ],
    );
  });
});
