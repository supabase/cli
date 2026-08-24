import { describe, expect, test } from "vitest";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { ProjectConfigParseError } from "./errors.ts";
import * as bunFacade from "./bun.ts";
import * as nodeFacade from "./node.ts";
import { makeProjectConfigIo } from "./promise-facade.ts";

const {
  findProjectPathsFor,
  findProjectRootFor,
  loadFunctionsManifest,
  loadProjectConfig,
  loadProjectConfigFile,
  loadProjectEnvironmentFor,
  saveProjectConfig,
} = bunFacade;

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

// mkdtemp against the OS temp dir (never a path under the repo) — a real
// project's ancestor-search would otherwise be able to walk up into this
// repo's own `apps/cli/docs/supabase` and resolve a project that isn't the
// one the test created.
function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-promise-facade-"));
}

describe("promise-facade via the Bun entrypoint", () => {
  test("loadProjectConfig resolves null when no Supabase project exists in the tree", async () => {
    const cwd = makeTempProject();

    try {
      await expect(loadProjectConfig(cwd)).resolves.toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadProjectConfig loads and decodes a real supabase/config.toml", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "facade-loaded-ref"\n');

      const loaded = await loadProjectConfig(cwd);

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

  test("saveProjectConfig then loadProjectConfigFile roundtrips the same effective config", async () => {
    const cwd = makeTempProject();

    try {
      const original = decodeProjectConfig({
        project_id: "facade-roundtrip-ref",
        db: { pooler: { enabled: true } },
      });

      const saved = await saveProjectConfig({ cwd, config: original });
      expect(saved.format).toBe("json");

      const loaded = await loadProjectConfigFile(saved.path);

      expect(loaded.config).toEqual(original);
      expect(loaded.path).toBe(saved.path);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("findProjectRootFor and findProjectPathsFor resolve from a nested cwd inside a temp project", async () => {
    const cwd = makeTempProject();
    const nested = join(cwd, "apps", "web", "src", "components");

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "nested-ref"\n');

      const root = await findProjectRootFor(nested);
      const paths = await findProjectPathsFor(nested);

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

  test("findProjectRootFor and findProjectPathsFor resolve to null when there is no project", async () => {
    const cwd = makeTempProject();

    try {
      await expect(findProjectRootFor(cwd)).resolves.toBeNull();
      await expect(findProjectPathsFor(cwd)).resolves.toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadProjectEnvironmentFor reads supabase/.env layered under an explicit baseEnv", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
      await writeFile(join(cwd, "supabase", ".env"), "GREETING=hello-from-dotenv\n");

      // `baseEnv` is passed explicitly (never the default `process.env`) so
      // this assertion can't be satisfied by an unrelated variable leaking in
      // from the real process environment.
      const projectEnv = await loadProjectEnvironmentFor({ cwd, baseEnv: {} });

      expect(projectEnv?.values.GREETING).toBe("hello-from-dotenv");
      expect(projectEnv?.sources.GREETING).toBe(".env");
      expect(projectEnv?.loadedPaths).toEqual([join(cwd, "supabase", ".env")]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadProjectEnvironmentFor honors an explicit baseEnv instead of silently defaulting to process.env", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "env-ref"\n');
      await writeFile(join(cwd, "supabase", ".env"), "GREETING=from-dotenv\n");

      const projectEnv = await loadProjectEnvironmentFor({
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
      const first = await loadProjectConfig(cwdA);
      const second = await loadProjectConfig(cwdB);

      expect(first?.config.project_id).toBe("first-ref");
      expect(second?.config.project_id).toBe("second-ref");
    } finally {
      await rm(cwdA, { recursive: true, force: true });
      await rm(cwdB, { recursive: true, force: true });
    }
  });
});

describe("promise-facade parity between bun.ts and node.ts", () => {
  test("node.ts exports the same seven facade function names as bun.ts", () => {
    const expectedFunctionNames = [
      "findProjectPathsFor",
      "findProjectRootFor",
      "loadFunctionsManifest",
      "loadProjectConfig",
      "loadProjectConfigFile",
      "loadProjectEnvironmentFor",
      "saveProjectConfig",
    ];

    expect(Object.keys(bunFacade).sort()).toEqual(expectedFunctionNames);
    expect(Object.keys(nodeFacade).sort()).toEqual(Object.keys(bunFacade).sort());
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
      const io = makeProjectConfigIo(countingLayer);

      await io.findProjectRootFor(cwd);
      await io.findProjectRootFor(cwd);

      expect(builds).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("promise-facade via the Node entrypoint", () => {
  // The "default"-condition path (`@supabase/config/io` resolving to
  // `./node.ts` outside Bun) otherwise has zero execution coverage.
  test("loadProjectConfig loads and decodes a real supabase/config.toml", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "node-facade-ref"\n');

      const loaded = await nodeFacade.loadProjectConfig(cwd);

      expect(loaded?.config.project_id).toBe("node-facade-ref");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("promise-facade rejection shapes", () => {
  test("loadProjectConfigFile rejects with a ProjectConfigParseError for a malformed config.toml", async () => {
    const cwd = makeTempProject();
    const configPath = join(cwd, "supabase", "config.toml");

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(configPath, "this is not === valid toml\n");

      await expect(loadProjectConfigFile(configPath)).rejects.toBeInstanceOf(
        ProjectConfigParseError,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loadProjectConfigFile rejects for a nonexistent path", async () => {
    const cwd = makeTempProject();
    const configPath = join(cwd, "supabase", "config.toml");

    try {
      await expect(loadProjectConfigFile(configPath)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("promise-facade stdin-leak regression (CLI-2231)", () => {
  // `BunServices.layer`/`NodeServices.layer` pull in Terminal, which attaches
  // a permanent `process.stdin` "end" listener on first use — this facade
  // only needs `FileSystem | Path` (see `bun.ts`/`node.ts`), so a facade call
  // must never grow that listener count.
  test("a facade call does not attach a process.stdin 'end' listener", async () => {
    const cwd = makeTempProject();
    const before = process.stdin.listenerCount("end");

    try {
      await loadProjectConfig(cwd);

      expect(process.stdin.listenerCount("end")).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
