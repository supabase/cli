import { gzipSync } from "node:zlib";
import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Schema } from "effect";
import { describe, expect, test } from "vitest";

import type { ComputeRecord } from "./compute-api.ts";
import {
  applyComputePull,
  computePullDesiredEntry,
  computePullMissingSource,
  computeSizeForConfig,
  planComputePull,
  restoreComputeSource,
} from "./compute-pull.ts";
import { createTar, type TarEntry } from "./tar.ts";

function deployed(overrides: Partial<ComputeRecord> = {}): ComputeRecord {
  return {
    name: "api",
    spec: { runtime: "node", size: "2gb-1vcpu", exposure: "public", instances: 1 },
    buildState: "active",
    ...overrides,
  };
}

/** A per-test project root, torn down with the test's scope. */
const withProjectRoot = <A, E, R>(
  run: (root: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-pull-" });
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      return yield* run(root, fs, path);
    }),
  ).pipe(Effect.provide(BunServices.layer));

describe("computeSizeForConfig", () => {
  test("reduces the API spelling to the memory the config records", () => {
    expect(computeSizeForConfig("2gb-1vcpu")).toBe("2gb");
    expect(computeSizeForConfig("4GB-2VCPU")).toBe("4gb");
  });

  test("records a size it cannot parse verbatim rather than guessing", () => {
    expect(computeSizeForConfig("xlarge")).toBe("xlarge");
  });
});

describe("computePullDesiredEntry", () => {
  test("reads an omitted spec.runtime as a Dockerfile build", () => {
    const entry = computePullDesiredEntry(
      deployed({ spec: { size: "2gb-1vcpu", exposure: "public", instances: 1 } }),
    );
    expect(entry.runtime).toBe("dockerfile");
  });

  test("drops an instance count the config schema could never hold", () => {
    const entry = computePullDesiredEntry(
      deployed({ spec: { runtime: "node", size: "2gb-1vcpu", exposure: "public", instances: -1 } }),
    );
    expect(entry.instances).toBeUndefined();
  });
});

describe("planComputePull", () => {
  test("plans every key of a compute the config has never heard of", () => {
    const plan = planComputePull({
      deployed: [deployed()],
      rootDocument: {},
      blockDocument: undefined,
    });

    expect(plan.deployed).toEqual(["api"]);
    expect(plan.hasWork).toBe(true);
    expect(plan.changes).toEqual([
      { name: "api", key: "runtime", local: undefined, remote: "node" },
      { name: "api", key: "size", local: undefined, remote: "2gb" },
      { name: "api", key: "exposure", local: undefined, remote: "public" },
      { name: "api", key: "instances", local: undefined, remote: 1 },
    ]);
  });

  test("plans nothing when the config already matches the deployed spec", () => {
    const plan = planComputePull({
      deployed: [deployed()],
      rootDocument: {
        compute: { api: { runtime: "node", size: "2gb", exposure: "public", instances: 1 } },
      },
      blockDocument: undefined,
    });

    expect(plan.hasWork).toBe(false);
    expect(plan.changes).toEqual([]);
  });

  test("plans only the keys that drifted, carrying the local value they replace", () => {
    const plan = planComputePull({
      deployed: [
        deployed({
          spec: { runtime: "node", size: "4gb-2vcpu", exposure: "private", instances: 3 },
        }),
      ],
      rootDocument: {
        compute: { api: { runtime: "node", size: "2gb", exposure: "public", instances: 3 } },
      },
      blockDocument: undefined,
    });

    expect(plan.changes).toEqual([
      { name: "api", key: "size", local: "2gb", remote: "4gb" },
      { name: "api", key: "exposure", local: "public", remote: "private" },
    ]);
  });

  test("treats a remote block's own spelling as the effective value, root as the fallback", () => {
    const plan = planComputePull({
      deployed: [deployed()],
      rootDocument: { compute: { api: { runtime: "deno", size: "2gb" } } },
      blockDocument: { compute: { api: { runtime: "node" } } },
    });

    // `runtime` and `size` already agree once the block overlays the root; only the two keys
    // neither scope declares are planned.
    expect(plan.changes.map((change) => change.key)).toEqual(["exposure", "instances"]);
  });

  test("refuses to write over an env() reference rather than erasing the indirection", () => {
    const plan = planComputePull({
      deployed: [deployed()],
      rootDocument: { compute: { api: { size: "env(COMPUTE_SIZE)" } } },
      blockDocument: undefined,
    });

    expect(plan.skipped).toContainEqual({ name: "api", key: "size", reason: "env_reference" });
    expect(plan.changes.map((change) => change.key)).not.toContain("size");
  });

  test("reports a configured compute with no deployment without planning anything for it", () => {
    const plan = planComputePull({
      deployed: [deployed()],
      rootDocument: { compute: { api: {}, retired: { runtime: "deno" } } },
      blockDocument: undefined,
    });

    expect(plan.localOnly).toEqual(["retired"]);
    expect(plan.changes.every((change) => change.name === "api")).toBe(true);
  });

  test("drops a deployed name that could never be a config key", () => {
    const plan = planComputePull({
      deployed: [deployed({ name: "Not A Label" })],
      rootDocument: {},
      blockDocument: undefined,
    });

    expect(plan.deployed).toEqual([]);
    expect(plan.hasWork).toBe(false);
  });
});

describe("applyComputePull", () => {
  it.live("appends a table for a compute the config never mentioned", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const configFilePath = path.join(root, "supabase", "config.toml");
        yield* fs.writeFileString(configFilePath, 'project_id = "demo"\n');

        yield* applyComputePull({
          plan: planComputePull({
            deployed: [deployed()],
            rootDocument: {},
            blockDocument: undefined,
          }),
          configFilePath,
          configPath: "supabase/config.toml",
          format: "toml",
          destinationPath: [],
        }).pipe(Effect.provide(BunServices.layer));

        const text = yield* fs.readFileString(configFilePath);
        expect(text).toContain('project_id = "demo"');
        expect(text).toContain('runtime = "node"');
        expect(text).toContain('size = "2gb"');
        expect(text).toContain('exposure = "public"');
        expect(text).toContain("instances = 1");
      }),
    ),
  );

  it.live("replaces a drifted value in place, leaving comments and neighbours alone", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const configFilePath = path.join(root, "supabase", "config.toml");
        yield* fs.writeFileString(
          configFilePath,
          [
            'project_id = "demo"',
            "",
            "# the API compute",
            "[compute.api]",
            'size = "2gb"',
            'runtime = "node"',
            'exposure = "public"',
            "instances = 1",
            "",
          ].join("\n"),
        );

        yield* applyComputePull({
          plan: planComputePull({
            deployed: [
              deployed({
                spec: { runtime: "node", size: "4gb-2vcpu", exposure: "public", instances: 1 },
              }),
            ],
            rootDocument: {
              compute: { api: { runtime: "node", size: "2gb", exposure: "public", instances: 1 } },
            },
            blockDocument: undefined,
          }),
          configFilePath,
          configPath: "supabase/config.toml",
          format: "toml",
          destinationPath: [],
        }).pipe(Effect.provide(BunServices.layer));

        const text = yield* fs.readFileString(configFilePath);
        expect(text).toContain("# the API compute");
        expect(text).toContain('size = "4gb"');
        expect(text).not.toContain('size = "2gb"');
        expect(text).toContain('runtime = "node"');
      }),
    ),
  );

  it.live("writes into the remote block the destination names", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const configFilePath = path.join(root, "supabase", "config.toml");
        yield* fs.writeFileString(
          configFilePath,
          [
            'project_id = "demo"',
            "",
            "[remotes.staging]",
            'project_id = "abcdefghijklmnopqrst"',
            "",
          ].join("\n"),
        );

        yield* applyComputePull({
          plan: planComputePull({
            deployed: [deployed()],
            rootDocument: {},
            blockDocument: undefined,
          }),
          configFilePath,
          configPath: "supabase/config.toml",
          format: "toml",
          destinationPath: ["remotes", "staging"],
        }).pipe(Effect.provide(BunServices.layer));

        const text = yield* fs.readFileString(configFilePath);
        expect(text).toContain("[remotes.staging.compute.api]");
        expect(text).not.toMatch(/^\[compute\.api\]/m);
      }),
    ),
  );

  it.live("records into a JSON project config, which the scaffold writer cannot edit", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const configFilePath = path.join(root, "supabase", "config.json");
        const encode = Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ project_id: Schema.String })),
        );
        yield* fs.writeFileString(configFilePath, yield* encode({ project_id: "demo" }));

        yield* applyComputePull({
          plan: planComputePull({
            deployed: [deployed()],
            rootDocument: { project_id: "demo" },
            blockDocument: undefined,
          }),
          configFilePath,
          configPath: "supabase/config.json",
          format: "json",
          destinationPath: [],
        }).pipe(Effect.provide(BunServices.layer));

        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              compute: Schema.Record(Schema.String, Schema.Struct({ size: Schema.String })),
            }),
          ),
        )(yield* fs.readFileString(configFilePath));
        expect(parsed.compute["api"]?.size).toBe("2gb");
      }),
    ),
  );

  it.live("refuses a layout the surgical editor cannot rewrite, writing nothing", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const configFilePath = path.join(root, "supabase", "config.toml");
        const before = 'project_id = "demo"\ncompute = { api = { size = "2gb" } }\n';
        yield* fs.writeFileString(configFilePath, before);

        const exit = yield* Effect.exit(
          applyComputePull({
            plan: planComputePull({
              deployed: [
                deployed({
                  spec: { runtime: "node", size: "4gb-2vcpu", exposure: "public", instances: 1 },
                }),
              ],
              rootDocument: { compute: { api: { size: "2gb" } } },
              blockDocument: undefined,
            }),
            configFilePath,
            configPath: "supabase/config.toml",
            format: "toml",
            destinationPath: [],
          }).pipe(Effect.provide(BunServices.layer)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.readFileString(configFilePath)).toBe(before);
      }),
    ),
  );
});

describe("computePullMissingSource", () => {
  it.live("names every deployed compute with no code in this checkout", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, "supabase", "compute", "api"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "packages", "worker"), { recursive: true });

        const missing = yield* computePullMissingSource({
          projectRoot: root,
          names: ["api", "worker", "ghost"],
          configuredSource: (name) => (name === "worker" ? "packages/worker" : undefined),
        }).pipe(Effect.provide(BunServices.layer));

        expect(missing).toEqual(["ghost"]);
      }),
    ),
  );

  it.live("reads a source that escapes the project as no local source at all", () =>
    withProjectRoot((root) =>
      Effect.gen(function* () {
        const missing = yield* computePullMissingSource({
          projectRoot: root,
          names: ["api"],
          configuredSource: () => "../../elsewhere",
        }).pipe(Effect.provide(BunServices.layer));

        expect(missing).toEqual(["api"]);
      }),
    ),
  );
});

describe("restoreComputeSource", () => {
  const gzip = (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes));

  const archiveOf = (entries: ReadonlyArray<TarEntry>) =>
    Effect.map(createTar(entries), gzip).pipe(Effect.provide(BunServices.layer));

  const file = (path: string, text: string, mode?: number): TarEntry => ({
    path,
    contents: new TextEncoder().encode(text),
    ...(mode === undefined ? {} : { mode }),
  });

  it.live("unpacks files, directories, and symlinks into the source directory", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        const archive = yield* archiveOf([
          file("index.ts", "export default 1;\n"),
          { path: "lib/", contents: new Uint8Array(0) },
          file("lib/util.ts", "export const x = 1;\n"),
          { path: "link.ts", contents: new Uint8Array(0), linkTarget: "index.ts" },
        ]);

        const count = yield* restoreComputeSource({
          name: "my-app",
          destination,
          archive,
        }).pipe(Effect.provide(BunServices.layer));

        expect(count).toBe(3);
        expect(yield* fs.readFileString(path.join(destination, "index.ts"))).toBe(
          "export default 1;\n",
        );
        expect(yield* fs.readFileString(path.join(destination, "lib", "util.ts"))).toBe(
          "export const x = 1;\n",
        );
        expect(yield* fs.readLink(path.join(destination, "link.ts"))).toBe("index.ts");
      }),
    ),
  );

  it.live("overwrites what the archive names and leaves other local files alone", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        yield* fs.makeDirectory(destination, { recursive: true });
        yield* fs.writeFileString(path.join(destination, "index.ts"), "stale\n");
        yield* fs.writeFileString(path.join(destination, "notes.md"), "mine\n");

        yield* restoreComputeSource({
          name: "my-app",
          destination,
          archive: yield* archiveOf([file("index.ts", "fresh\n")]),
        }).pipe(Effect.provide(BunServices.layer));

        expect(yield* fs.readFileString(path.join(destination, "index.ts"))).toBe("fresh\n");
        expect(yield* fs.readFileString(path.join(destination, "notes.md"))).toBe("mine\n");
      }),
    ),
  );

  it.live("preserves the executable bit the archive records", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        yield* restoreComputeSource({
          name: "my-app",
          destination,
          archive: yield* archiveOf([file("run.sh", "#!/bin/sh\n", 0o755)]),
        }).pipe(Effect.provide(BunServices.layer));

        const info = yield* fs.stat(path.join(destination, "run.sh"));
        expect(info.mode & 0o111).not.toBe(0);
      }),
    ),
  );

  it.live.each([
    { label: "a parent-directory traversal", path: "../escaped.ts" },
    { label: "a nested traversal that normalizes out of the tree", path: "a/../../escaped.ts" },
    { label: "an absolute path", path: "/tmp/escaped.ts" },
  ])("refuses $label, writing nothing", ({ path: entryPath }) =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        const exit = yield* Effect.exit(
          restoreComputeSource({
            name: "my-app",
            destination,
            archive: yield* archiveOf([file("index.ts", "ok\n"), file(entryPath, "pwned\n")]),
          }).pipe(Effect.provide(BunServices.layer)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        // Refused before the first write, so even the legitimate sibling entry is absent.
        expect(yield* fs.exists(path.join(destination, "index.ts"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "supabase", "compute", "escaped.ts"))).toBe(false);
      }),
    ),
  );

  it.live("refuses a symlink pointing outside the source directory, writing nothing", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        const exit = yield* Effect.exit(
          restoreComputeSource({
            name: "my-app",
            destination,
            archive: yield* archiveOf([
              file("index.ts", "ok\n"),
              { path: "escape", contents: new Uint8Array(0), linkTarget: "../../../../etc" },
            ]),
          }).pipe(Effect.provide(BunServices.layer)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.exists(path.join(destination, "index.ts"))).toBe(false);
      }),
    ),
  );

  it.live("replaces an existing symlink rather than writing through it", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        const outside = path.join(root, "outside.ts");
        yield* fs.makeDirectory(destination, { recursive: true });
        yield* fs.writeFileString(outside, "untouched\n");
        yield* fs.symlink(outside, path.join(destination, "index.ts"));

        yield* restoreComputeSource({
          name: "my-app",
          destination,
          archive: yield* archiveOf([file("index.ts", "fresh\n")]),
        }).pipe(Effect.provide(BunServices.layer));

        expect(yield* fs.readFileString(path.join(destination, "index.ts"))).toBe("fresh\n");
        // The write landed on the link's own path, not on whatever it pointed at.
        expect(yield* fs.readFileString(outside)).toBe("untouched\n");
      }),
    ),
  );

  it.live("refuses bytes that are not a gzip archive", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        const exit = yield* Effect.exit(
          restoreComputeSource({
            name: "my-app",
            destination,
            archive: new TextEncoder().encode("not a gzip"),
          }).pipe(Effect.provide(BunServices.layer)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.exists(destination)).toBe(false);
      }),
    ),
  );

  it.live("refuses a hard-link entry rather than silently skipping it", () =>
    withProjectRoot((root, fs, path) =>
      Effect.gen(function* () {
        const destination = path.join(root, "supabase", "compute", "my-app");
        // Typeflag '1' (hard link) can name any file already on disk; `readTar` rejects it.
        const tar = yield* createTar([file("index.ts", "ok\n")]).pipe(
          Effect.provide(BunServices.layer),
        );
        tar[156] = "1".charCodeAt(0);
        let checksum = 0;
        tar.fill(0x20, 148, 156);
        for (let index = 0; index < 512; index++) checksum += tar[index]!;
        const digits = checksum.toString(8).padStart(6, "0");
        for (let index = 0; index < digits.length; index++) {
          tar[148 + index] = digits.charCodeAt(index);
        }
        tar[154] = 0;
        tar[155] = 0x20;

        const exit = yield* Effect.exit(
          restoreComputeSource({
            name: "my-app",
            destination,
            archive: gzip(tar),
          }).pipe(Effect.provide(BunServices.layer)),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.exists(path.join(destination, "index.ts"))).toBe(false);
      }),
    ),
  );
});
