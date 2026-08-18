import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  messagesOfType,
  setupWorkers,
} from "../../../../../tests/helpers/workers.ts";
import {
  InvalidWorkerNameError,
  InvalidWorkerSourceError,
  UnknownWorkerRuntimeError,
  UnknownWorkerSizeError,
  WorkerDirectoryExistsError,
} from "../../../../shared/workers/workers.errors.ts";
import { workersNew } from "./new.handler.ts";
import type { WorkersNewFlags } from "./new.command.ts";

const CONFIG_WITH_COMMENTS = `# hand-written, and it should stay that way
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

function flags(overrides: Partial<WorkersNewFlags> = {}): WorkersNewFlags {
  return {
    name: Option.none(),
    runtime: Option.none(),
    size: Option.none(),
    source: Option.none(),
    force: false,
    ...overrides,
  };
}

function project(files: Readonly<Record<string, string>> = {}) {
  const created = makeWorkersProject({
    "supabase/config.toml": CONFIG_WITH_COMMENTS,
    ...files,
  });
  const configPath = join(created.dir, "supabase", "config.toml");
  return {
    dir: created.dir,
    config: () => readFileSync(configPath, "utf8"),
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

describe("workers new", () => {
  it.live("scaffolds the runtime's starter files and records the choice", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      const workerDir = join(repo.dir, "supabase", "workers", "api");
      expect(existsSync(join(workerDir, "index.js"))).toBe(true);
      expect(existsSync(join(workerDir, "package.json"))).toBe(true);

      expect(repo.config()).toBe(
        `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
      );

      expect(messagesOfType(out, "success")).toContain("Created worker.");
      expect(messagesOfType(out, "outro")).toContain("Next: supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("generates a valid worker name when none is given", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ runtime: Option.some("deno"), size: Option.some("2gb") }));

      const match = /\[workers\.(?<name>[a-z0-9-]+)\]/.exec(repo.config());
      const name = match?.groups?.["name"];
      expect(name).toMatch(/^worker-[a-z]+-\d{5}$/);
      expect(existsSync(join(repo.dir, "supabase", "workers", name ?? "", "main.ts"))).toBe(true);
      expect(messagesOfType(out, "info").some((line) => line.includes("Auto-assigned"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("prompts for runtime and size when neither is given", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      cwd: repo.dir,
      promptSelectResponses: ["python", "4gb"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
        "Which runtime should this worker use?",
        "Which instance size should this worker use?",
      ]);
      expect(repo.config()).toContain('runtime = "python"');
      expect(repo.config()).toContain('size = "4gb"');
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "main.py"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the defaults without prompting when not interactive", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir, format: "json" });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toContain('runtime = "deno"');
      expect(repo.config()).toContain('size = "2gb"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reuses an existing config entry instead of re-asking", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("bun"), size: Option.some("4gb") }),
      );
      // The second run gives no runtime or size at all: the recorded ones answer for it.
      yield* workersNew(flags({ name: Option.some("api"), force: true }));

      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toContain('runtime = "bun"');
      expect(repo.config()).toContain('size = "4gb"');
      expect(
        messagesOfType(out, "info").some((line) => line.includes("Reusing the existing")),
      ).toBe(true);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.ts"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records a --source worker relative to the project root", () => {
    const repo = project();
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({
          name: Option.some("api"),
          runtime: Option.some("node"),
          source: Option.some("packages/api"),
        }),
      );

      expect(existsSync(join(repo.dir, "packages", "api", "index.js"))).toBe(true);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toContain('source = "packages/api"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a --source that --force would delete outside the worker", () => {
    const repo = project({ "README.md": "keep me", "src/app.ts": "keep me too" });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      for (const source of [".", "..", "supabase", "supabase/functions"]) {
        const error = yield* workersNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("node"),
            source: Option.some(source),
            force: true,
          }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidWorkerSourceError);
      }

      // Nothing was removed: --force never reached a directory it should not own.
      expect(existsSync(join(repo.dir, "README.md"))).toBe(true);
      expect(existsSync(join(repo.dir, "src", "app.ts"))).toBe(true);
      expect(repo.config()).toContain("project_id");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not claim to reuse an entry that has nothing recorded", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\n`,
    });
    const { layer, out } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(messagesOfType(out, "info").some((line) => line.includes("Reusing"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("honours [workers] root", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers]\nroot = "services"\n`,
    });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(existsSync(join(repo.dir, "supabase", "services", "api", "index.js"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("scaffolds in a directory that has no Supabase project yet", () => {
    const created = makeWorkersProject();
    const { layer } = setupWorkers({ cwd: created.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(existsSync(join(created.dir, "supabase", "workers", "api", "index.js"))).toBe(true);
      expect(readFileSync(join(created.dir, "supabase", "config.toml"), "utf8")).toBe(
        `[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
      );
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });

  it.live("refuses a non-empty destination unless --force is given", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "leftover.txt"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("replaces the destination wholesale with --force", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node"), force: true }),
      );

      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "leftover.txt"))).toBe(false);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.js"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a name that could not become a hostname", () => {
    const repo = project();
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(flags({ name: Option.some("My_Worker") })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a config.toml that records an unknown runtime or size", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "rust"\n`,
    });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const runtimeError = yield* workersNew(flags({ name: Option.some("api") })).pipe(Effect.flip);
      expect(runtimeError).toBeInstanceOf(UnknownWorkerRuntimeError);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a config.toml that records an unknown size", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "64gb"\n`,
    });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const sizeError = yield* workersNew(flags({ name: Option.some("api") })).pipe(Effect.flip);
      expect(sizeError).toBeInstanceOf(UnknownWorkerSizeError);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses [workers] root pointed at a directory the CLI owns", () => {
    const repo = project({
      "supabase/config.toml": `project_id = "demo"\n\n[workers]\nroot = "functions"\n`,
    });
    const { layer } = setupWorkers({ cwd: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("InvalidWorkersRootError");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
