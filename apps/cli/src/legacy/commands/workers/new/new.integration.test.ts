import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
} from "../../../../../tests/helpers/legacy-workers.ts";
import { WorkerAlreadyConfiguredError } from "../../../../shared/workers/worker-config.ts";
import {
  InvalidWorkerNameError,
  InvalidWorkerSourceError,
  WorkerDirectoryExistsError,
} from "../../../../shared/workers/workers.errors.ts";
import { legacyWorkersNew } from "./new.handler.ts";
import type { LegacyWorkersNewFlags } from "./new.command.ts";

const CONFIG_WITH_COMMENTS = `# hand-written, and it should stay that way
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

function flags(overrides: Partial<LegacyWorkersNewFlags> = {}): LegacyWorkersNewFlags {
  return {
    name: "api",
    runtime: Option.none(),
    size: Option.none(),
    source: Option.none(),
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

describe("legacy workers new", () => {
  it.live("scaffolds the runtime's starter files and records the choice", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api", runtime: Option.some("node") }));

      const workerDir = join(repo.dir, "supabase", "workers", "api");
      expect(existsSync(join(workerDir, "index.mjs"))).toBe(true);
      expect(repo.config()).toBe(
        `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
      );

      // Declarative line first, then the detail rows, then the next step —
      // the shape `functions new` established.
      expect(out.stdoutText).toContain("Created new Worker at supabase/workers/api");
      expect(out.stdoutText).toContain("Runtime");
      expect(out.stdoutText).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("prompts for runtime and size when neither is given", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      promptSelectResponses: ["node", "4gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api" }));

      expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
        "Which runtime should this worker use?",
        "Which instance size should this worker use?",
      ]);
      expect(repo.config()).toContain('runtime = "node"');
      expect(repo.config()).toContain('size = "4gb"');
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the defaults without prompting when not interactive", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, format: "json" });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api" }));

      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toContain('runtime = "deno"');
      expect(repo.config()).toContain('size = "2gb"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A second `new` for the same name is refused rather than re-recorded. Changing
  // a worker that exists is a `config.toml` edit, and the file is the user's.
  it.live("refuses a name that config.toml already records", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("deno"), size: Option.some("4gb") }),
      );
      const recorded = repo.config();

      const error = yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
      // Refused before anything was asked, and the entry is byte-identical.
      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toBe(recorded);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Refused whichever way the entry happens to be written — the decoded config
  // is what answers "does this exist", so no TOML shape matters here.
  it.live.each(['workers.api.runtime = "node"', "[workers.api]"])(
    "refuses an entry recorded as %s",
    (entry) => {
      const config = `project_id = "demo"\n\n${entry}\n`;
      const repo = project({ "supabase/config.toml": config });
      const { layer } = setupLegacyWorkers({ workdir: repo.dir });

      return Effect.gen(function* () {
        const error = yield* legacyWorkersNew(
          flags({ name: "api", runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
        expect(repo.config()).toBe(config);
        // Nothing scaffolded either.
        expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    },
  );

  it.live("records a --source worker relative to the project root", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(
        flags({
          name: "api",
          runtime: Option.some("node"),
          source: Option.some("packages/api"),
        }),
      );

      expect(existsSync(join(repo.dir, "packages", "api", "index.mjs"))).toBe(true);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toContain('source = "packages/api"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a --source outside the directories a worker may own", () => {
    const repo = project({ "README.md": "keep me", "src/app.ts": "keep me too" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      for (const source of [".", "..", "supabase", "supabase/functions"]) {
        const error = yield* legacyWorkersNew(
          flags({
            name: "api",
            runtime: Option.some("node"),
            source: Option.some(source),
          }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidWorkerSourceError);
      }

      // Nothing was written: the resolver refused before any directory was created.
      expect(existsSync(join(repo.dir, "README.md"))).toBe(true);
      expect(existsSync(join(repo.dir, "src", "app.ts"))).toBe(true);
      expect(repo.config()).toContain("project_id");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("scaffolds in a directory that has no Supabase project yet", () => {
    const created = makeWorkersProject();
    const { layer } = setupLegacyWorkers({ workdir: created.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api", runtime: Option.some("node") }));

      expect(existsSync(join(created.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
      expect(readFileSync(join(created.dir, "supabase", "config.toml"), "utf8")).toBe(
        `[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
      );
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });

  it.live("refuses a destination that already has something in it", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "leftover.txt"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Scaffolding into an empty directory is fine — it is only a destination with
  // contents that is refused.
  it.live("scaffolds into a directory that exists but is empty", () => {
    const repo = project();
    mkdirSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api", runtime: Option.some("node") }));

      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("tells the user how to proceed when the destination is occupied", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      // No flag to suggest any more, so the advice has to be actionable on its own.
      const suggestion = error instanceof WorkerDirectoryExistsError ? error.suggestion : "";
      expect(suggestion).toContain("Remove");
      expect(suggestion).not.toContain("--force");
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a name that could not become a hostname", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(flags({ name: "My_Worker" })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("keeps stdout parseable under -o json", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, goOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ runtime: Option.some("node") }));

      const payload: unknown = JSON.parse(out.stdoutText);
      expect(payload).toMatchObject({ runtime: "node", size: "2gb" });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Why the config edit is planned before the starter files are written: this
  // failure is knowable up front, and discovering it afterwards would leave a
  // scaffold on disk that nothing records.
  it.live("writes no scaffold at all when the config edit cannot be made", () => {
    const repo = project({
      "supabase/config.toml": 'project_id = "demo"\n\nworkers.api.runtime = "node"\n',
    });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("deno") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
      // No directory, and config.toml exactly as it was.
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toBe('project_id = "demo"\n\nworkers.api.runtime = "node"\n');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A plain file used to read as an empty directory, which then failed with a
  // bare EEXIST from `makeDirectory` instead of naming what was in the way.
  it.live("refuses a plain file at the destination", () => {
    const repo = project({ "supabase/workers/api": "not a directory" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: "api", runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      expect(readFileSync(join(repo.dir, "supabase", "workers", "api"), "utf8")).toBe(
        "not a directory",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A relative `--source` is something typed at a shell prompt, so it means
  // what it would mean to the shell: relative to where you are.
  it.live("resolves a relative --source against the directory it was typed in", () => {
    const repo = project({ "apps/web/.keep": "" });
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      cwd: join(repo.dir, "apps", "web"),
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(
        flags({
          name: "api",
          runtime: Option.some("node"),
          source: Option.some("generated"),
        }),
      );

      expect(existsSync(join(repo.dir, "apps", "web", "generated", "index.mjs"))).toBe(true);
      expect(existsSync(join(repo.dir, "generated"))).toBe(false);
      // Persisted project-root-relative, with forward slashes on every platform.
      expect(repo.config()).toContain('source = "apps/web/generated"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Clack writes its prompt UI to stdout with no stream override, and `-o json`
  // leaves `output.format` as `text` — so a prompt lands in front of the payload
  // exactly as the notices did.
  it.live("does not prompt under -o json, so stdout stays parseable", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "json",
      // Answers are available, so a prompt would succeed and corrupt stdout
      // rather than fail the test some other way.
      promptSelectResponses: ["node", "4gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: "api" }));

      const payload: unknown = JSON.parse(out.stdoutText);
      // The defaults stand, because there was nowhere to ask.
      expect(payload).toMatchObject({ runtime: "deno", size: "2gb" });
      expect(out.promptSelectCalls).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses --source pointed at the project config file", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({
          name: "api",
          runtime: Option.some("node"),
          source: Option.some(join("supabase", "config.toml")),
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerSourceError);
      // The config survived, which is the whole point.
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
