import * as NodeFSP from "node:fs/promises";
// Supervisor source is embedded in bundles because it executes in independent Node processes.
for (const name of ["runner", "watchdog"]) {
  const source = await NodeFSP.readFile(new URL("../src/" + name + ".js", import.meta.url), "utf8");
  const target = new URL("../src/" + name + "-program.js", import.meta.url);
  const encoded = "export default " + JSON.stringify(source) + ";\n";
  if (process.argv.includes("--check")) {
    if ((await import(target.href)).default !== source)
      throw new Error("Regenerate broker supervisor programs.");
  } else await NodeFSP.writeFile(target, encoded);
}
