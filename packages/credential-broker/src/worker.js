/** Internal host entry: arguments contain paths and command metadata, never credentials. */
export async function runCredentialWorker(kind) {
  process.argv = [process.execPath, process.argv[1], ...process.argv.slice(4)];
  if (kind === "runner") await import("./runner.js");
  else if (kind === "watchdog") await import("./watchdog.js");
  else throw new Error("Unknown credential worker.");
}
