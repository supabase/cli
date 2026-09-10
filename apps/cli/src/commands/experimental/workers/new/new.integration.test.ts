import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { makeWorkersProject, setupWorkers } from "../../../../../tests/helpers/workers.ts";
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
import { workersNew } from "./new.handler.ts";
import type { WorkersNewFlags } from "./new.command.ts";

const CONFIG_WITH_COMMENTS = `# hand-written, and it should stay that way
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

function flags(overrides: Partial<WorkersNewFlags> = {}): WorkersNewFlags {
  return {
    name: Option.some("api"),
    runtime: Option.none(),
    size: Option.none(),
    exposure: Option.none(),
    instances: Option.none(),
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

describe("workers new", () => {
  it.live("scaffolds the runtime's starter files and records the choice", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      const workerDir = join(repo.dir, "supabase", "workers", "api");
      expect(existsSync(join(workerDir, "index.mjs"))).toBe(true);
      expect(repo.config()).toBe(
        `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
      );

      expect(out.stdoutText).toContain("Created new Worker at supabase/workers/api");
      expect(out.stdoutText).toContain("Runtime");
      expect(out.stderrText).toContain("supabase experimental workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("asks for the name when the command line carries none", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["orders"],
      promptSelectResponses: ["node", "2gb"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.none() }));

      expect(out.promptTextCalls.map((call) => call.message)).toEqual([
        "What should this worker be called?",
      ]);
      expect(existsSync(join(repo.dir, "supabase", "workers", "orders", "index.mjs"))).toBe(true);
      expect(repo.config()).toContain("[workers.orders]");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a bad or already-recorded name at the name prompt", () => {
    const repo = project({
      "supabase/config.toml": `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
    });
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptTextResponses: ["orders"],
      promptSelectResponses: ["node", "2gb"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.none() }));

      const validate = out.promptTextCalls[0]?.opts?.validate;
      expect(validate).toBeDefined();
      expect(validate?.("My_Worker")).toContain("lowercase letters");
      expect(validate?.("api")).toContain("already configured");
      expect(validate?.("orders")).toBeUndefined();
      expect(existsSync(join(repo.dir, "supabase", "workers", "orders", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live.each([
    { label: "not interactive", setup: { interactive: false } },
    // Stdout is a TTY, but claimed by the payload, so a prompt would corrupt it.
    { label: "-o json", setup: { goOutput: "json" as const } },
    // Stdout is still a terminal, so `output.interactive` alone would have fed
    // piped stdin straight into the name prompt instead of taking this path.
    { label: "piped stdin", setup: { stdinIsTty: false } },
  ])("refuses a bare new when there is nowhere to ask ($label)", ({ setup }) => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      // An answer is waiting, so a prompt would succeed rather than fail some other way.
      promptTextResponses: ["orders"],
      ...setup,
    });

    return Effect.gen(function* () {
      const error = yield* workersNew(flags({ name: Option.none() })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(MissingWorkerNameError);
      if (!(error instanceof MissingWorkerNameError)) {
        return yield* Effect.die("expected MissingWorkerNameError");
      }
      expect(error.suggestion).toContain("supabase experimental workers new");
      expect(out.promptTextCalls).toEqual([]);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("prompts for runtime, size and exposure when none is given", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      promptSelectResponses: ["node", "4gb", "private"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
        "Which runtime should this worker use?",
        "Which instance size should this worker use?",
        "Should this worker be reachable from the internet?",
      ]);
      expect(repo.config()).toContain('runtime = "node"');
      expect(repo.config()).toContain('size = "4gb"');
      expect(repo.config()).toContain('exposure = "private"');
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records the chosen exposure so a later push keeps it", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ exposure: Option.some("private") }));

      expect(repo.config()).toContain('exposure = "private"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records an instance count that differs from the default", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ instances: Option.some(3) }));

      expect(repo.config()).toContain("instances = 3");
      expect(repo.config()).not.toContain('instances = "3"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("writes a count the config loader can read back", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), instances: Option.some(3) }));
      yield* workersNew(flags({ name: Option.some("web") }));

      expect(repo.config()).toContain("instances = 3");
      expect(repo.config()).toContain("[workers.web]");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records a zero instance count", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ instances: Option.some(0) }));

      expect(repo.config()).toContain("instances = 0");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("writes no instance count when nothing names one", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags());

      expect(repo.config()).not.toContain("instances");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("writes no instance count when the default is named explicitly", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ instances: Option.some(1) }));

      expect(repo.config()).not.toContain("instances");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records the default exposure when nothing names one", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir, format: "json" });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(repo.config()).toContain('exposure = "public"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("takes the defaults without prompting when stdin is piped", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      stdinIsTty: false,
      promptSelectResponses: ["node", "4gb", "private"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls).toEqual([]);
      expect(repo.config()).toContain('runtime = "deno"');
      expect(repo.config()).toContain('size = "2gb"');
      expect(repo.config()).toContain('exposure = "public"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the defaults without prompting when not interactive", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir, format: "json" });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toContain('runtime = "deno"');
      expect(repo.config()).toContain('size = "2gb"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a name that config.toml already records", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({
          name: Option.some("api"),
          runtime: Option.some("deno"),
          size: Option.some("4gb"),
          exposure: Option.some("public"),
        }),
      );
      const recorded = repo.config();

      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
      expect(out.promptSelectCalls).toHaveLength(0);
      expect(repo.config()).toBe(recorded);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live.each(['workers.api.runtime = "node"', "[workers.api]"])(
    "refuses an entry recorded as %s",
    (entry) => {
      const config = `project_id = "demo"\n\n${entry}\n`;
      const repo = project({ "supabase/config.toml": config });
      const { layer } = setupWorkers({ workdir: repo.dir });

      return Effect.gen(function* () {
        const error = yield* workersNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
        expect(repo.config()).toBe(config);
        expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    },
  );

  it.live(
    "refuses a name the reader would discover in a config.json-only ancestor project (defaulted workdir)",
    () => {
      const created = makeWorkersProject({
        "supabase/config.json": JSON.stringify({
          project_id: "demo",
          workers: { api: { runtime: "node", size: "2gb" } },
        }),
      });
      const sub = join(created.dir, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const cleanup = () => rmSync(created.dir, { recursive: true, force: true });
      const { layer } = setupWorkers({ workdir: sub, explicitWorkdir: false });

      return Effect.gen(function* () {
        const error = yield* workersNew(
          flags({ name: Option.some("api"), runtime: Option.some("deno") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
        expect(existsSync(join(sub, "supabase"))).toBe(false);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
    },
  );

  it.live(
    "does not refuse the same name when --workdir is explicit (writer and reader agree on the same root)",
    () => {
      const created = makeWorkersProject({
        "supabase/config.json": JSON.stringify({
          project_id: "demo",
          workers: { api: { runtime: "node", size: "2gb" } },
        }),
      });
      const sub = join(created.dir, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const cleanup = () => rmSync(created.dir, { recursive: true, force: true });
      const { layer } = setupWorkers({ workdir: sub, explicitWorkdir: true });

      return Effect.gen(function* () {
        yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("deno") }));
        expect(existsSync(join(sub, "supabase", "config.toml"))).toBe(true);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
    },
  );

  it.live("records a --source worker relative to the project root", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
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
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      for (const source of [".", "..", "supabase", "supabase/functions"]) {
        const error = yield* workersNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("node"),
            source: Option.some(source),
          }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidWorkerSourceError);
      }

      expect(existsSync(join(repo.dir, "README.md"))).toBe(true);
      expect(existsSync(join(repo.dir, "src", "app.ts"))).toBe(true);
      expect(repo.config()).toContain("project_id");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("scaffolds in a directory that has no Supabase project yet", () => {
    const created = makeWorkersProject();
    const { layer, out } = setupWorkers({ workdir: created.dir, explicitWorkdir: true });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      const workerDir = join(created.dir, "supabase", "workers", "api");
      expect(existsSync(join(workerDir, "index.mjs"))).toBe(true);
      expect(readFileSync(join(created.dir, "supabase", "config.toml"), "utf8")).toBe(
        `[workers.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
      );
      expect(out.stdoutText).toContain(`Created new Worker at ${workerDir}`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });

  it.live("refuses a destination that already has something in it", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "leftover.txt"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("scaffolds into a directory that exists but is empty", () => {
    const repo = project();
    mkdirSync(join(repo.dir, "supabase", "workers", "api"), { recursive: true });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(existsSync(join(repo.dir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("tells the user how to proceed when the destination is occupied", () => {
    const repo = project({ "supabase/workers/api/leftover.txt": "old" });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      const suggestion = error instanceof WorkerDirectoryExistsError ? error.suggestion : "";
      expect(suggestion).toContain("Remove");
      expect(suggestion).not.toContain("--force");
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a name that could not become a hostname", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(flags({ name: Option.some("My_Worker") })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(existsSync(join(repo.dir, "supabase", "workers"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
  it.live("keeps stdout parseable under -o json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir, goOutput: "json" });

    return Effect.gen(function* () {
      yield* workersNew(flags({ runtime: Option.some("node") }));

      const payload: unknown = JSON.parse(out.stdoutText);
      expect(payload).toMatchObject({
        worker_name: "api",
        runtime: "node",
        size: "2gb",
        vcpu: 1,
        exposure: "public",
        instances: 1,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports the chosen exposure and count under -o json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir, goOutput: "json" });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({
          runtime: Option.some("node"),
          exposure: Option.some("private"),
          instances: Option.some(3),
        }),
      );

      expect(JSON.parse(out.stdoutText)).toMatchObject({
        exposure: "private",
        instances: 3,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("shows the exposure and declared count in the details block", () => {
    const repo = project();
    const { layer, out } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({
          runtime: Option.some("node"),
          exposure: Option.some("private"),
          instances: Option.some(3),
        }),
      );

      expect(out.stdoutText).toContain("Access");
      expect(out.stdoutText).toContain("private");
      expect(out.stdoutText).toContain("3 declared");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("writes no scaffold at all when the config edit cannot be made", () => {
    const repo = project({
      "supabase/config.toml": 'project_id = "demo"\n\nworkers.api.runtime = "node"\n',
    });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("deno") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toBe('project_id = "demo"\n\nworkers.api.runtime = "node"\n');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("leaves config.json alone in a project that has one", () => {
    const configJson = `${JSON.stringify({ project_id: "demo" }, null, 2)}\n`;
    const repo = project({ "supabase/config.json": configJson });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      const jsonPath = join(repo.dir, "supabase", "config.json");
      expect(readFileSync(jsonPath, "utf8")).toBe(configJson);
      expect(() => JSON.parse(readFileSync(jsonPath, "utf8"))).not.toThrow();

      expect(repo.config()).toBe(
        `${CONFIG_WITH_COMMENTS}\n[workers.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records the worker in --workdir's own project, not an ancestor's", () => {
    const repo = project({ "bare-dir/.keep": "" });
    const workdir = join(repo.dir, "bare-dir");
    const { layer } = setupWorkers({ workdir });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);

      expect(readFileSync(join(workdir, "supabase", "config.toml"), "utf8")).toBe(
        '[workers.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n',
      );
      expect(existsSync(join(workdir, "supabase", "workers", "api", "index.mjs"))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("writes no scaffold when [workers] is a sealed inline table", () => {
    const before = 'project_id = "demo"\n\nworkers = { web = { runtime = "node" } }\n';
    const repo = project({ "supabase/config.toml": before });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerConfigWriteUnsafeError);
      expect(existsSync(join(repo.dir, "supabase", "workers", "api"))).toBe(false);
      expect(repo.config()).toBe(before);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses a plain file at the destination", () => {
    const repo = project({ "supabase/workers/api": "not a directory" });
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({ name: Option.some("api"), runtime: Option.some("node") }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerDirectoryExistsError);
      expect(readFileSync(join(repo.dir, "supabase", "workers", "api"), "utf8")).toBe(
        "not a directory",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("resolves a relative --source against the directory it was typed in", () => {
    const repo = project({ "apps/web/.keep": "" });
    const { layer } = setupWorkers({
      workdir: repo.dir,
      cwd: join(repo.dir, "apps", "web"),
    });

    return Effect.gen(function* () {
      yield* workersNew(
        flags({
          name: Option.some("api"),
          runtime: Option.some("node"),
          source: Option.some("generated"),
        }),
      );

      expect(existsSync(join(repo.dir, "apps", "web", "generated", "index.mjs"))).toBe(true);
      expect(existsSync(join(repo.dir, "generated"))).toBe(false);
      expect(repo.config()).toContain('source = "apps/web/generated"');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not prompt under -o json, so stdout stays parseable", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      goOutput: "json",
      // Answers are available, so a prompt would succeed and corrupt stdout
      // rather than fail the test some other way.
      promptSelectResponses: ["node", "4gb"],
    });

    return Effect.gen(function* () {
      yield* workersNew(flags({ name: Option.some("api") }));

      const payload: unknown = JSON.parse(out.stdoutText);
      expect(payload).toMatchObject({ runtime: "deno", size: "2gb" });
      expect(out.promptSelectCalls).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("falls back to the defaults when a prompt answers off-menu", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      promptSelectResponses: ["cobol", "colossal", "sideways"],
    });

    return Effect.gen(function* () {
      yield* workersNew({
        name: Option.some("api"),
        runtime: Option.none(),
        size: Option.none(),
        exposure: Option.none(),
        instances: Option.none(),
        source: Option.none(),
      });

      expect(repo.config()).toContain(`runtime = "deno"`);
      expect(repo.config()).toContain(`size = "2gb"`);
      expect(repo.config()).toContain(`exposure = "public"`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses --source pointed at the project config file", () => {
    const repo = project();
    const { layer } = setupWorkers({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* workersNew(
        flags({
          name: Option.some("api"),
          runtime: Option.some("node"),
          source: Option.some(join("supabase", "config.toml")),
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerSourceError);
      expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live(
    "fails without scaffolding anything when --workdir names a directory that does not exist at all",
    () => {
      const repo = project();
      const badWorkdir = join(repo.dir, "does-not-exist");
      const { layer } = setupWorkers({ workdir: badWorkdir, explicitWorkdir: true });

      return Effect.gen(function* () {
        const exit = yield* workersNew(flags()).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("WorkersNewWorkdirError");
        expect(rendered).toContain("failed to change workdir: chdir");

        expect(existsSync(join(badWorkdir, "supabase"))).toBe(false);
        expect(repo.config()).toBe(CONFIG_WITH_COMMENTS);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    },
  );
});
