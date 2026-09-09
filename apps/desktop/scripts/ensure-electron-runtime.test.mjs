import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { electronDownloadArgs } from "./ensure-electron-runtime.mjs";

NodeTest.describe("Electron runtime download", () => {
  NodeTest.it("retries transient transfer failures within a bounded window", () => {
    NodeAssert.deepEqual(
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
