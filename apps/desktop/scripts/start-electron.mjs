import * as NodeChildProcess from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
const handleSigint = () => forwardSignal("SIGINT");
const handleSigterm = () => forwardSignal("SIGTERM");
process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);

child.on("exit", (code, signal) => {
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
