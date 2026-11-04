import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export class ProfileRegistry {
  #writes = Promise.resolve();
  constructor({ file, home = homedir(), env = process.env, platform = process.platform }) {
    this.file = file;
    this.home = home;
    this.env = env;
    this.platform = platform;
  }
  expand(directory) {
    return directory === "~"
      ? this.home
      : directory.startsWith("~/")
        ? join(this.home, directory.slice(2))
        : directory;
  }
  async saved() {
    try {
      const entries = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(entries)) throw new Error("Invalid profile registry.");
      return entries
        .filter(
          (entry) =>
            typeof entry?.name === "string" &&
            typeof entry.directory === "string" &&
            isAbsolute(entry.directory),
        )
        .map(({ name, directory }) => ({ name, directory }));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async write(entries) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await rename(temporary, this.file);
  }
  update(transform) {
    const task = this.#writes.then(async () => this.write(transform(await this.saved())));
    this.#writes = task.catch(() => {});
    return task;
  }
  remember(name, directory) {
    return this.update((entries) => [
      ...entries.filter((entry) => entry.directory !== directory),
      { name, directory },
    ]);
  }
  forget(directory) {
    return this.update((entries) => entries.filter((entry) => entry.directory !== directory));
  }
  async list() {
    const entries = new Map(
      (await this.saved()).map((entry) => [entry.directory, { ...entry, saved: true }]),
    );
    const candidates = [
      this.env.BITWARDENCLI_APPDATA_DIR,
      join(
        this.home,
        this.platform === "darwin"
          ? "Library/Application Support/Bitwarden CLI"
          : ".config/Bitwarden CLI",
      ),
    ];
    // Bound discovery to immediate children; vault data is never opened.
    for (const root of [
      join(this.home, ".config"),
      join(this.home, "Library/Application Support"),
    ]) {
      const children = await readdir(root, { withFileTypes: true }).catch(() => []);
      candidates.push(
        ...children
          .filter((entry) => entry.isDirectory())
          .slice(0, 512)
          .map((entry) => join(root, entry.name)),
      );
    }
    for (const candidate of candidates.filter(Boolean)) {
      try {
        const directory = await realpath(this.expand(candidate));
        if ((await stat(join(directory, "data.json"))).isFile() && !entries.has(directory)) {
          entries.set(directory, { name: basename(directory), directory, saved: false });
        }
      } catch {}
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
