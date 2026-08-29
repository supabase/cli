import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
} from "../../../../../tests/helpers/legacy-workers.ts";
import {
  WorkerAlreadyConfiguredError,
  WorkerConfigWriteUnsafeError,
} from "../../../../shared/workers/worker-config.ts";
import {
  InvalidWorkerNameError,
  InvalidWorkerSourceError,
  MissingWorkerNameError,
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
    name: Option.some("api"),
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
      yield* legacyWorkersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

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
  it.live("asks for the name when the command line carries none", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      promptTextResponses: ["orders"],
      promptSelectResponses: ["node", "2gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.none() }));

      expect(out.promptTextCalls.map((call) => call.message)).toEqual([
        "What should this worker be called?",
      ]);
      expect(existsSync(join(repo.dir, "supabase", "workers", "orders", "index.mjs"))).toBe(true);
      expect(repo.config()).toContain("[workers.orders]");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The prompt is the last place a mistyped or taken name can be corrected
  // without ending the run, so it refuses both there rather than after asking.
  it.live("refuses a bad or already-recorded name at the name prompt", () => {
    const repo = project({
      "supabase/config.toml": `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
    });
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      promptTextResponses: ["orders"],
      promptSelectResponses: ["node", "2gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.none() }));

      const validate = out.promptTextCalls[0]?.opts?.validate;
      expect(validate).toBeDefined();
      expect(validate?.("My_Worker")).toContain("lowercase letters");
      expect(validate?.("api")).toContain("already configured");
      expect(validate?.("orders")).toBeUndefined();
      expect(existsSync(join(repo.dir, "supabase", "workers", "orders", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Nowhere to ask means nothing to scaffold under: the name is the directory,
  // the config key and the hostname, and none of those has a default.
  it.live.each([
    { label: "not interactive", setup: { interactive: false } },
    // A TTY, but stdout was claimed by the payload, so a prompt would corrupt it.
    { label: "-o json", setup: { goOutput: "json" as const } },
    // `printf 'orders\n' | supabase workers new`: stdout is still a terminal, so
    // `output.interactive` on its own would have fed the pipe straight into the
    // name prompt instead of taking this documented path.
    { label: "piped stdin", setup: { stdinIsTty: false } },
  ])("refuses a bare new when there is nowhere to ask ($label)", ({ setup }) => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      // An answer is waiting, so a prompt would succeed rather than fail some
      // other way.
      promptTextResponses: ["orders"],
      ...setup,
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(flags({ name: Option.none() })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(MissingWorkerNameError);
      expect(out.promptTextCalls).toEqual([]);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("prompts for runtime and size when neither is given", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      promptSelectResponses: ["node", "4gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
        "Which runtime should this worker use?",
        "Which instance size should this worker use?",
      ]);
      expect(repo.config()).toContain('runtime = "node"');
      expect(repo.config()).toContain('size = "4gb"');
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The runtime and size prompts do have defaults to fall back on, so a piped
  // stdin must leave them unasked rather than consuming the pipe.
  it.live("takes the defaults without prompting when stdin is piped", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      stdinIsTty: false,
      promptSelectResponses: ["node", "4gb"],
    });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls).toEqual([]);
      expect(repo.config()).toContain('runtime = "deno"');
      expect(repo.config()).toContain('size = "2gb"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the defaults without prompting when not interactive", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({ workdir: repo.dir, format: "json" });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.some("api") }));

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
        flags({ name: Option.some("api"), runtime: Option.some("deno"), size: Option.some("4gb") }),
      );
      const recorded = repo.config();

      const error = yield* legacyWorkersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
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
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
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
          name: Option.some("api"),
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
            name: Option.some("api"),
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
      yield* legacyWorkersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

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
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
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
      yield* legacyWorkersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("tells the user how to proceed when the destination is occupied", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
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
      const error = yield* legacyWorkersNew(flags({ name: Option.some("My_Worker") })).pipe(
        Effect.flip,
      );

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
        flags({ name: Option.some("api"), runtime: Option.some("deno") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
      // No directory, and config.toml exactly as it was.
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toBe('project_id = "demo"\n\nworkers.api.runtime = "node"\n');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // The project config loader prefers `supabase/config.json` when one exists,
  // and the entry writer is a TOML text editor. Without `tomlOnly` the two
  // disagree: the plan targets the JSON file and appends a `[workers.api]`
  // table to it, leaving the project config unparseable — after the scaffold is
  // already on disk.
  it.live("leaves config.json alone in a project that has one", () => {
    const configJson = `${JSON.stringify({ project_id: "demo" }, null, 2)}\n`;
    const repo = project({ "supabase/config.json": configJson });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      const jsonPath = join(repo.dir, "supabase", "config.json");
      expect(readFileSync(jsonPath, "utf8")).toBe(configJson);
      expect(() => JSON.parse(readFileSync(jsonPath, "utf8"))).not.toThrow();

      // The worker is recorded in config.toml, which is the TOML editor's file.
      expect(repo.config()).toBe(
        `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\n`,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `settings.workdir` is already an authoritative project root, so the config
  // loader must not climb out of it. Without `search: false` it does: the entry
  // is appended to the *ancestor's* config.toml recording `source =
  // "supabase/workers/api"`, which resolves against the ancestor root to a
  // directory the scaffold never created, while the scaffold itself lands under
  // the workdir. Both sides have to name the same project.
  it.live("records the worker in --workdir's own project, not an ancestor's", () => {
    const repo = project({ "bare-dir/.keep": "" });
    const workdir = join(repo.dir, "bare-dir");
    const { layer } = setupLegacyWorkers({ workdir });

    return Effect.gen(function* () {
      yield* legacyWorkersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      // The ancestor project is untouched.
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);

      // The workdir got both the entry and the scaffold it points at.
      expect(readFileSync(join(workdir, "supabase", "config.toml"), "utf8")).toBe(
        '[workers.api]\nruntime = "node"\nsize = "2gb"\n',
      );
      expect(existsSync(join(workdir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A sealed inline `[workers]` cannot be extended by appending a table, and
  // the name is absent from the decoded section, so the already-configured
  // check does not fire. Parsing the plan is what refuses it — before the
  // scaffold is written, like every other refusal here.
  it.live("writes no scaffold when [workers] is a sealed inline table", () => {
    const before = 'project_id = "demo"\n\nworkers = { web = { runtime = "node" } }\n';
    const repo = project({ "supabase/config.toml": before });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerConfigWriteUnsafeError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toBe(before);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A plain file used to read as an empty directory, which then failed with a
  // bare EEXIST from `makeDirectory` instead of naming what was in the way.
  it.live("refuses a plain file at the destination", () => {
    const repo = project({ "supabase/workers/api": "not a directory" });
    const { layer } = setupLegacyWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
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
          name: Option.some("api"),
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
      yield* legacyWorkersNew(flags({ name: Option.some("api") }));

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
          name: Option.some("api"),
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
