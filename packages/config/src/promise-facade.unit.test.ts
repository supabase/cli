import { describe, expect, test } from "vitest";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema, type Scope } from "effect";
import { CliConfigSchema } from "./base.ts";
import { CliConfigParseError } from "./errors.ts";
import * as bunFacade from "./bun.ts";
import * as defaultEntrypoint from "./index.ts";
import * as ioBrowserFacade from "./io-browser.ts";
import * as nodeFacade from "./node.ts";
import { makeCliConfigIo } from "./promise-facade.ts";

const {
  findCliProjectPaths,
  findCliProjectRoot,
  inferFunctionsManifest,
  loadCliConfig,
  loadCliConfigFile,
  loadCliProjectEnvironment,
  saveCliConfig,
} = bunFacade;

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

// Under the OS temp dir, never a path under this repo — otherwise ancestor-search could
// walk up into this repo's own `apps/cli/docs/supabase` fixture.
function makeTempProject() {
  return FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "supabase-promise-facade-" }),
  );
}

function runFacadeTest<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );
}

describe("promise-facade via the Bun entrypoint", () => {
  test("loadCliConfig resolves null when no Supabase project exists in the tree", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        yield* Effect.promise(() => expect(loadCliConfig(cwd)).resolves.toBeNull());
      }),
    ));

  test("loadCliConfig loads and decodes a real supabase/config.toml", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          'project_id = "facade-loaded-ref"\n',
        );

        const loaded = yield* Effect.promise(() => loadCliConfig(cwd));

        expect(loaded?.config.project_id).toBe("facade-loaded-ref");
        expect(loaded?.config.db.major_version).toBe(17);
        expect(loaded?.format).toBe("toml");
        expect(loaded?.path).toBe(join(cwd, "supabase", "config.toml"));
      }),
    ));

  test("saveCliConfig then loadCliConfigFile roundtrips the same effective config", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        const original = decodeCliConfig({
          project_id: "facade-roundtrip-ref",
          db: { pooler: { enabled: true } },
        });

        const saved = yield* Effect.promise(() => saveCliConfig({ cwd, config: original }));
        expect(saved.format).toBe("json");

        const loaded = yield* Effect.promise(() => loadCliConfigFile(saved.path));

        expect(loaded.config).toEqual(original);
        expect(loaded.path).toBe(saved.path);
      }),
    ));

  test("findCliProjectRoot and findCliProjectPaths resolve from a nested cwd inside a temp project", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const nested = join(cwd, "apps", "web", "src", "components");

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          'project_id = "nested-ref"\n',
        );

        const root = yield* Effect.promise(() => findCliProjectRoot(nested));
        const paths = yield* Effect.promise(() => findCliProjectPaths(nested));

        expect(root).toBe(cwd);
        expect(paths).toEqual({
          projectRoot: cwd,
          supabaseDir: join(cwd, "supabase"),
          configPath: join(cwd, "supabase", "config.toml"),
          envPath: join(cwd, "supabase", ".env"),
          envLocalPath: join(cwd, "supabase", ".env.local"),
        });
      }),
    ));

  test("findCliProjectRoot and findCliProjectPaths resolve to null when there is no project", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        yield* Effect.promise(() => expect(findCliProjectRoot(cwd)).resolves.toBeNull());
        yield* Effect.promise(() => expect(findCliProjectPaths(cwd)).resolves.toBeNull());
      }),
    ));

  test("loadCliProjectEnvironment reads supabase/.env layered under an explicit baseEnv", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
        yield* fs.writeFileString(join(cwd, "supabase", ".env"), "GREETING=hello-from-dotenv\n");

        // Explicit empty baseEnv, so no ambient process.env variable can satisfy this assertion.
        const projectEnv = yield* Effect.promise(() =>
          loadCliProjectEnvironment({ cwd, baseEnv: {} }),
        );

        expect(projectEnv?.values.GREETING).toBe("hello-from-dotenv");
        expect(projectEnv?.sources.GREETING).toBe(".env");
        expect(projectEnv?.loadedPaths).toEqual([join(cwd, "supabase", ".env")]);
      }),
    ));

  test("loadCliProjectEnvironment honors an explicit baseEnv instead of silently defaulting to process.env", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
        yield* fs.writeFileString(join(cwd, "supabase", ".env"), "GREETING=from-dotenv\n");

        const projectEnv = yield* Effect.promise(() =>
          loadCliProjectEnvironment({
            cwd,
            baseEnv: { GREETING: "from-explicit-base-env" },
          }),
        );

        expect(projectEnv?.values.GREETING).toBe("from-explicit-base-env");
        expect(projectEnv?.sources.GREETING).toBe("ambient");
      }),
    ));

  test("inferFunctionsManifest resolves an empty manifest when no functions directory exists", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          'project_id = "functions-ref"\n',
        );

        yield* Effect.promise(() => expect(inferFunctionsManifest(cwd)).resolves.toEqual({}));
      }),
    ));

  test("two sequential facade calls both succeed, exercising the shared lazy runtime", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwdA = yield* makeTempProject();
        const cwdB = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwdA, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwdA, "supabase", "config.toml"),
          'project_id = "first-ref"\n',
        );
        yield* fs.makeDirectory(join(cwdB, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwdB, "supabase", "config.toml"),
          'project_id = "second-ref"\n',
        );

        const first = yield* Effect.promise(() => loadCliConfig(cwdA));
        const second = yield* Effect.promise(() => loadCliConfig(cwdB));

        expect(first?.config.project_id).toBe("first-ref");
        expect(second?.config.project_id).toBe("second-ref");
      }),
    ));
});

const expectedFacadeFunctionNames = [
  "findCliProjectPaths",
  "findCliProjectRoot",
  "inferFunctionsManifest",
  "loadCliConfig",
  "loadCliConfigFile",
  "loadCliProjectEnvironment",
  "saveCliConfig",
];

describe("promise-facade parity between bun.ts, node.ts, and io-browser.ts", () => {
  test("io-browser.ts exports the same seven facade function names as bun.ts and node.ts", () => {
    for (const facade of [bunFacade, nodeFacade, ioBrowserFacade]) {
      for (const name of expectedFacadeFunctionNames) {
        expect(typeof (facade as Record<string, unknown>)[name]).toBe("function");
      }
    }
  });

  test("bun.ts, node.ts, and io-browser.ts export the identical set of names", () => {
    expect(Object.keys(nodeFacade).sort()).toEqual(Object.keys(bunFacade).sort());
    expect(Object.keys(ioBrowserFacade).sort()).toEqual(Object.keys(bunFacade).sort());
  });
});

describe("./io is a superset of src/index.ts", () => {
  test("every runtime export key of index.ts is present, with an identical (not shadowed) binding, in bun.ts, node.ts, and io-browser.ts", () => {
    const defaultKeys = Object.keys(defaultEntrypoint);

    expect(defaultKeys.length).toBeGreaterThan(0);

    for (const [label, facade] of [
      ["bun.ts", bunFacade],
      ["node.ts", nodeFacade],
      ["io-browser.ts", ioBrowserFacade],
    ] as const) {
      const mismatches = defaultKeys.flatMap((key) => {
        if (!(key in facade)) {
          return [`${label} missing: ${key}`];
        }
        const defaultValue = (defaultEntrypoint as Record<string, unknown>)[key];
        const facadeValue = (facade as Record<string, unknown>)[key];
        return facadeValue === defaultValue ? [] : [`${label} mismatched (shadowed): ${key}`];
      });

      expect(mismatches).toEqual([]);
    }
  });
});

describe("io-browser.ts stays side-effect-free", () => {
  // Dynamic import so a regression back to a top-level throw fails this test
  // specifically, instead of crashing the whole file at module-load time.
  test("importing the module does not throw", () =>
    expect(import("./io-browser.ts")).resolves.toBeDefined());

  test("calling loadCliConfig rejects with the curated browser-unavailable message", () =>
    expect(ioBrowserFacade.loadCliConfig("/irrelevant")).rejects.toThrow(
      '@supabase/config/io is not available in browser bundles; import the pure surface from "@supabase/config" instead.',
    ));
});

describe("promise-facade singleton runtime", () => {
  test("builds the underlying ManagedRuntime exactly once across multiple facade calls", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();
        let builds = 0;

        const countingLayer = Layer.mergeAll(
          BunFileSystem.layer,
          BunPath.layer,
          Layer.effectDiscard(
            Effect.sync(() => {
              builds += 1;
            }),
          ),
        );
        const io = makeCliConfigIo(countingLayer);

        yield* Effect.promise(() => io.findCliProjectRoot(cwd));
        yield* Effect.promise(() => io.findCliProjectRoot(cwd));

        expect(builds).toBe(1);
      }),
    ));
});

describe("promise-facade via the Node entrypoint", () => {
  test("loadCliConfig loads and decodes a real supabase/config.toml", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          'project_id = "node-facade-ref"\n',
        );

        const loaded = yield* Effect.promise(() => nodeFacade.loadCliConfig(cwd));

        expect(loaded?.config.project_id).toBe("node-facade-ref");
      }),
    ));
});

describe("promise-facade rejection shapes", () => {
  test("loadCliConfigFile rejects with a CliConfigParseError for a malformed config.toml", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const configPath = join(cwd, "supabase", "config.toml");

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(configPath, "this is not === valid toml\n");

        yield* Effect.promise(() =>
          expect(loadCliConfigFile(configPath)).rejects.toBeInstanceOf(CliConfigParseError),
        );
      }),
    ));

  test("loadCliConfigFile rejects for a nonexistent path", () =>
    runFacadeTest(
      Effect.gen(function* () {
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const configPath = join(cwd, "supabase", "config.toml");

        yield* Effect.promise(() => expect(loadCliConfigFile(configPath)).rejects.toThrow());
      }),
    ));
});

// The stdin-leak guard lives in `promise-facade.stdin.unit.test.ts`, which needs its own
// vitest-isolated file to observe the facade's first call.
