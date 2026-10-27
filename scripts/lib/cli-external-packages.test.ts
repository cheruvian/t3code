import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";

import {
  isRuntimeExternalCliDependency,
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

// Native bindings live in optionalDependencies; checking dependencies alone misses them.
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
  ),
});
type PackageManifest = typeof PackageManifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

describe("shouldBundleCliDependency", () => {
  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@napi-rs/keyring",
      "@clerk/electron-passkeys",
      "node-addon-api",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // It is transitive to a selected dependency root, so the runtime closure test
  // below ensures it follows that root into the sidecar.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      [
        "@cursor/sdk",
        "@ff-labs/fff-node",
        "@napi-rs/keyring",
        "node-pty",
        "playwright-core",
        "undici",
        "zod",
      ],
    );
  });
});

// An external package is loaded from the real filesystem, so its own `require`
// also resolves from the real filesystem. If one of its dependencies was
// bundled away instead of left external, that dependency does not follow the
// selected root into the sidecar.
//
// Found the hard way: msgpackr-extract's node-gyp-build-optional-packages
// required detect-libc, which was bundled. Windows was fine; WSL got
// MODULE_NOT_FOUND.
it.layer(NodeServices.layer)("external package dependency closure", (it) => {
  // Follow installed dependency links, including pnpm's shared virtual store.
  // Read package.json by path so package exports cannot hide the manifest.
  const readInstalledPackages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(
      path.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../apps/server",
    );
    const installed = new Map<string, PackageManifest>();
    const visited = new Set<string>();
    const queue = Object.keys(serverPackageJson.dependencies)
      .filter(isRuntimeExternalCliDependency)
      .map((name) => ({ name, from: root }));
    for (const { name, from } of queue) {
      let directory = from;
      let manifestPath: string | undefined;
      while (true) {
        const candidate = path.join(directory, "node_modules", name, "package.json");
        if (yield* fileSystem.exists(candidate)) {
          manifestPath = yield* fileSystem.realPath(candidate);
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      // Optional platform packages can be absent on this host.
      if (manifestPath === undefined || visited.has(manifestPath)) continue;
      visited.add(manifestPath);
      const manifest = decodeManifest(yield* fileSystem.readFileString(manifestPath));
      installed.set(name, manifest);
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }))
        queue.push({ name: dependency, from: path.dirname(manifestPath) });
    }
    return installed;
  }).pipe(Effect.cached, Effect.runSync);

  const isRuntimeExternal = isRuntimeExternalCliDependency;

  // A cold walk of the pnpm store can exceed the root timeout when the Windows
  // lane runs four filesystem-heavy workspace suites at once.
  it.effect(
    "finds the runtime-external packages on disk",
    () =>
      Effect.gen(function* () {
        const installed = yield* readInstalledPackages;
        const found = [...installed.keys()].filter(isRuntimeExternal);

        // Without this the closure check below can pass vacuously: if nothing is
        // read, nothing is checked. node-pty is the one native root every
        // platform ships, and node-addon-api is its transitive runtime
        // dependency, so require them by name.
        for (const required of ["node-pty", "node-addon-api"]) {
          assert.ok(
            found.includes(required),
            `expected ${required} in the pnpm store; the closure check is only meaningful if it can read these (found ${found.length})`,
          );
        }
      }),
    120_000,
  );

  it.effect("keeps every runtime dependency of an external package external too", () =>
    Effect.gen(function* () {
      const installed = yield* readInstalledPackages;
      const violations: string[] = [];
      const seen = new Set<string>();
      // Seeded from the installed runtime dependency graph, so scoped
      // prefixes like "@yuuang/" and "@ff-labs/" are covered too. Seeding from
      // the prefix strings themselves would skip every scoped entry, since a
      // prefix is not a package name.
      const queue = [...installed.keys()].filter(isRuntimeExternal);

      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);

        const manifest = installed.get(name);
        if (!manifest) continue;

        const declared = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        for (const dependency of Object.keys(declared)) {
          if (!isRuntimeExternal(dependency)) {
            violations.push(`${name} -> ${dependency}`);
          }
          if (!seen.has(dependency)) queue.push(dependency);
        }
      }

      assert.deepStrictEqual(
        violations,
        [],
        `these dependencies of external packages would be bundled away and fail to resolve under WSL: ${violations.join(", ")}`,
      );
    }),
  );

  // The stage installs only externals the server lists, so a required peer must be reachable from them.
  it.effect("stages a provider for every required peer of a staged external", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const installed = yield* readInstalledPackages;
      const server = decodeManifest(
        yield* fileSystem.readFileString(
          path.resolve(
            path.dirname(NodeURL.fileURLToPath(import.meta.url)),
            "../../apps/server/package.json",
          ),
        ),
      );

      const staged = new Set<string>();
      const queue = Object.keys(selectCliRuntimeExternalDependencies(server.dependencies ?? {}));
      for (const name of queue) {
        if (staged.has(name)) continue;
        staged.add(name);
        const manifest = installed.get(name);
        queue.push(
          ...Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies }),
        );
      }

      const missing = [...staged].flatMap((name) => {
        const manifest = installed.get(name);
        return Object.keys(manifest?.peerDependencies ?? {})
          .filter((peer) => !manifest?.peerDependenciesMeta?.[peer]?.optional && !staged.has(peer))
          .map((peer) => `${name} -> ${peer}`);
      });

      assert.deepStrictEqual(
        missing,
        [],
        `these peers of staged external packages are missing from the packaged app; add them to apps/server dependencies: ${missing.join(", ")}`,
      );
    }),
  );
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/node-addon-api@7.1.1/node_modules/node-addon-api/index.js") +
      region(
        "../../node_modules/.pnpm/node-gyp-build-optional-packages@5.2.2/node_modules/node-gyp-build-optional-packages/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["node-addon-api", "node-gyp-build-optional-packages"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("flags scoped external packages", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/@ff-labs/fff-node/dist/src/index.js"),
    );
    assert.deepStrictEqual(result.inlined, ["@ff-labs/fff-node"]);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  // The scan has to answer both directions. Checking only that externals are
  // absent still passes on a bundle that externalized everything, which is the
  // failure this whole change prevents.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/yaml@2.4.0/node_modules/yaml/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "yaml"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("reads the plain `// <path>` markers newer Rolldown emits", () => {
    const source = [
      "// \0rolldown/runtime.js",
      "var x = 1;",
      "// ../../node_modules/.pnpm/node-addon-api@7.1.1/node_modules/node-addon-api/index.js",
      "var y = 2; // trailing comment",
      "// ../../src/server/main.ts",
      "",
    ].join("\n");
    const result = findInlinedExternalPackages(source);

    assert.strictEqual(result.regionCount, 3);
    assert.deepStrictEqual(result.inlined, ["node-addon-api"]);
  });
});

// The single-executable build can only `import` built-ins. A file-backed
// import of an external package passes every bundler check and the regular
// `node dist/bin.mjs` path, then fails inside the executable, so the scan
// reads the emitted module graph instead.
describe("findEsmImportsOfExternalPackages", () => {
  it("flags static and dynamic imports of file-backed packages", () => {
    const source = [
      'import { FileFinder } from "@ff-labs/fff-node";',
      'import * as fs from "fs";',
      'import { createRequire } from "node:module";',
      'const pty = () => import("node-pty");',
      'const data = () => import("@ff-labs/fff-bin-linux-x64-gnu", { with: { type: "json" } });',
      'const lazy = () => import(/* @vite-ignore */ "ffi-rs");',
      'const local = () => import("./chunk-abc.mjs");',
    ].join("\n");

    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "@ff-labs/fff-bin-linux-x64-gnu",
      "@ff-labs/fff-node",
      "ffi-rs",
      "node-pty",
    ]);
  });

  it("flags side-effect imports and re-exports too", () => {
    const source = ['import "msgpackr-extract";', 'export { load } from "ffi-rs";'].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "ffi-rs",
      "msgpackr-extract",
    ]);
  });

  it("ignores imports inside generated extension source and comments", () => {
    const source = [
      'const extension = `import { Type } from "typebox";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`;',
      '// import "comment-only";',
      "const example = 'import(\"string-only\")';",
      'const interpolated = `source ${import("real-package")}`;',
    ].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), ["real-package"]);
  });

  it("allows optional dynamic Bun built-ins but rejects static imports", () => {
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('const load = () => import("bun:sqlite");'),
      [],
    );
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('import { Database } from "bun:sqlite";'),
      ["bun:sqlite"],
    );
  });

  it("does not mistake createRequire calls for imports", () => {
    const source = 'const { FileFinder } = createRequire(import.meta.url)("@ff-labs/fff-node");';
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), []);
  });
});
