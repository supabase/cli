import { describe, expect, test } from "vitest";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { CliConfigSchema } from "./base.ts";
import { CliConfigParseError } from "./errors.ts";
import * as bunFacade from "./bun.ts";
import * as defaultEntrypoint from "./index.ts";
import * as ioBrowserFacade from "./io-browser.ts";
import * as nodeFacade from "./node.ts";
import { makeCliConfigIo } from "./promise-facade.ts";

const {
  findCliProjectPathsFor,
  findCliProjectRootFor,
  loadFunctionsManifest,
  loadCliConfig,
  loadCliConfigFile,
  loadCliProjectEnvironmentFor,
  saveCliConfig,
} = bunFacade;

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

// mkdtemp against the OS temp dir (never a path under the repo) — a real
// project's ancestor-search would otherwise be able to walk up into this
// repo's own `apps/cli/docs/supabase` and resolve a project that isn't the
// one the test created.
function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-promise-facade-"));
}

describe("promise-facade via the Bun entrypoint", () => {
  test("loadCliConfig resolves null when no Supabase project exists in the tree", async () => {
    const cwd = makeTempProject();

    try {
      await expect(loadCliConfig(cwd)).resolves.toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadCliConfig loads and decodes a real supabase/config.toml", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "facade-loaded-ref"\n');

      const loaded = await loadCliConfig(cwd);

      expect(loaded?.config.project_id).toBe("facade-loaded-ref");
      // `db.major_version` is never set in the fixture above — asserting it
      // resolves to the schema default proves the facade runs the real
      // decode path, not just a raw TOML parse.
      expect(loaded?.config.db.major_version).toBe(17);
      expect(loaded?.format).toBe("toml");
      expect(loaded?.path).toBe(join(cwd, "supabase", "config.toml"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("saveCliConfig then loadCliConfigFile roundtrips the same effective config", async () => {
    const cwd = makeTempProject();

    try {
      const original = decodeCliConfig({
        project_id: "facade-roundtrip-ref",
        db: { pooler: { enabled: true } },
      });

      const saved = await saveCliConfig({ cwd, config: original });
      expect(saved.format).toBe("json");

      const loaded = await loadCliConfigFile(saved.path);

      expect(loaded.config).toEqual(original);
      expect(loaded.path).toBe(saved.path);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("findCliProjectRootFor and findCliProjectPathsFor resolve from a nested cwd inside a temp project", async () => {
    const cwd = makeTempProject();
    const nested = join(cwd, "apps", "web", "src", "components");

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "nested-ref"\n');

      const root = await findCliProjectRootFor(nested);
      const paths = await findCliProjectPathsFor(nested);

      expect(root).toBe(cwd);
      expect(paths).toEqual({
        projectRoot: cwd,
        supabaseDir: join(cwd, "supabase"),
        configPath: join(cwd, "supabase", "config.toml"),
        envPath: join(cwd, "supabase", ".env"),
        envLocalPath: join(cwd, "supabase", ".env.local"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("findCliProjectRootFor and findCliProjectPathsFor resolve to null when there is no project", async () => {
    const cwd = makeTempProject();

    try {
      await expect(findCliProjectRootFor(cwd)).resolves.toBeNull();
      await expect(findCliProjectPathsFor(cwd)).resolves.toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadCliProjectEnvironmentFor reads supabase/.env layered under an explicit baseEnv", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
      await writeFile(join(cwd, "supabase", ".env"), "GREETING=hello-from-dotenv\n");

      // `baseEnv` is passed explicitly (never the default `process.env`) so
      // this assertion can't be satisfied by an unrelated variable leaking in
      // from the real process environment.
      const projectEnv = await loadCliProjectEnvironmentFor({ cwd, baseEnv: {} });

      expect(projectEnv?.values.GREETING).toBe("hello-from-dotenv");
      expect(projectEnv?.sources.GREETING).toBe(".env");
      expect(projectEnv?.loadedPaths).toEqual([join(cwd, "supabase", ".env")]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadCliProjectEnvironmentFor honors an explicit baseEnv instead of silently defaulting to process.env", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
      await writeFile(join(cwd, "supabase", ".env"), "GREETING=from-dotenv\n");

      const projectEnv = await loadCliProjectEnvironmentFor({
        cwd,
        baseEnv: { GREETING: "from-explicit-base-env" },
      });

      expect(projectEnv?.values.GREETING).toBe("from-explicit-base-env");
      expect(projectEnv?.sources.GREETING).toBe("ambient");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadFunctionsManifest resolves an empty manifest when no functions directory exists", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "functions-ref"\n');

      await expect(loadFunctionsManifest(cwd)).resolves.toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("two sequential facade calls both succeed, exercising the shared lazy runtime", async () => {
    const cwdA = makeTempProject();
    const cwdB = makeTempProject();

    try {
      await mkdir(join(cwdA, "supabase"), { recursive: true });
      await writeFile(join(cwdA, "supabase", "config.toml"), 'project_id = "first-ref"\n');
      await mkdir(join(cwdB, "supabase"), { recursive: true });
      await writeFile(join(cwdB, "supabase", "config.toml"), 'project_id = "second-ref"\n');

      // The runtime is built lazily on the first call below and cached for
      // reuse — a second, independent call on the same module-level facade
      // must still resolve correctly rather than reusing stale state from
      // the first.
      const first = await loadCliConfig(cwdA);
      const second = await loadCliConfig(cwdB);

      expect(first?.config.project_id).toBe("first-ref");
      expect(second?.config.project_id).toBe("second-ref");
    } finally {
      await rm(cwdA, { recursive: true, force: true });
      await rm(cwdB, { recursive: true, force: true });
    }
  });
});

const expectedFacadeFunctionNames = [
  "findCliProjectPathsFor",
  "findCliProjectRootFor",
  "loadFunctionsManifest",
  "loadCliConfig",
  "loadCliConfigFile",
  "loadCliProjectEnvironmentFor",
  "saveCliConfig",
];

describe("promise-facade parity between bun.ts, node.ts, and io-browser.ts", () => {
  // io-browser.ts must export the same facade names as bun.ts/node.ts: a
  // bundler resolving the "browser" condition needs every named import to
  // exist at build time.
  test("io-browser.ts exports the same seven facade function names as bun.ts and node.ts", () => {
    for (const facade of [bunFacade, nodeFacade, ioBrowserFacade]) {
      for (const name of expectedFacadeFunctionNames) {
        expect(typeof (facade as Record<string, unknown>)[name]).toBe("function");
      }
    }
  });

  // Each module also re-exports every pure symbol from `.` (see
  // `describe("./io is a superset of src/index.ts", ...)` below), so this
  // asserts the three modules' full export surfaces stay identical to each
  // other, not just on the seven facade names above.
  test("bun.ts, node.ts, and io-browser.ts export the identical set of names", () => {
    expect(Object.keys(nodeFacade).sort()).toEqual(Object.keys(bunFacade).sort());
    expect(Object.keys(ioBrowserFacade).sort()).toEqual(Object.keys(bunFacade).sort());
  });
});

describe("./io is a superset of src/index.ts", () => {
  test("every runtime export key of index.ts is present, with an identical (not shadowed) binding, in bun.ts, node.ts, and io-browser.ts", () => {
    const defaultKeys = Object.keys(defaultEntrypoint);

    // Guards against `defaultEntrypoint` being empty due to a broken
    // import, which would otherwise make the loop below pass trivially.
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
  // Uses a dynamic `import()` (rather than relying on the static import at
  // the top of this file) so this assertion is meaningful on its own: a
  // regression back to a bare top-level `throw` would fail this specific
  // test with the rejection below, instead of crashing the whole file at
  // module-load time before any test runs.
  test("importing the module does not throw", async () => {
    await expect(import("./io-browser.ts")).resolves.toBeDefined();
  });

  test("calling loadCliConfig rejects with the curated browser-unavailable message", async () => {
    await expect(ioBrowserFacade.loadCliConfig("/irrelevant")).rejects.toThrow(
      '@supabase/config/io is not available in browser bundles; import the pure surface from "@supabase/config" instead.',
    );
  });
});

describe("promise-facade singleton runtime", () => {
  test("builds the underlying ManagedRuntime exactly once across multiple facade calls", async () => {
    const cwd = makeTempProject();
    let builds = 0;

    try {
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

      await io.findCliProjectRootFor(cwd);
      await io.findCliProjectRootFor(cwd);

      expect(builds).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("promise-facade via the Node entrypoint", () => {
  // The "default"-condition path (`@supabase/config/io` resolving to
  // `./node.ts` outside Bun) otherwise has zero execution coverage.
  test("loadCliConfig loads and decodes a real supabase/config.toml", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "node-facade-ref"\n');

      const loaded = await nodeFacade.loadCliConfig(cwd);

      expect(loaded?.config.project_id).toBe("node-facade-ref");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("promise-facade rejection shapes", () => {
  test("loadCliConfigFile rejects with a CliConfigParseError for a malformed config.toml", async () => {
    const cwd = makeTempProject();
    const configPath = join(cwd, "supabase", "config.toml");

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(configPath, "this is not === valid toml\n");

      await expect(loadCliConfigFile(configPath)).rejects.toBeInstanceOf(CliConfigParseError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadCliConfigFile rejects for a nonexistent path", async () => {
    const cwd = makeTempProject();
    const configPath = join(cwd, "supabase", "config.toml");

    try {
      await expect(loadCliConfigFile(configPath)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// The stdin-leak guard lives in `promise-facade.stdin.unit.test.ts`: it must
// observe the facade's FIRST call, which only a dedicated vitest-isolated
// file can guarantee.
