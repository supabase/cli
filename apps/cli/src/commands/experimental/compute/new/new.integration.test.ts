import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, FileSystem, Path, Schema } from "effect";
import { makeComputeProject, setupCompute } from "../../../../../tests/helpers/compute.ts";
import {
  ComputeAlreadyConfiguredError,
  ComputeConfigWriteUnsafeError,
} from "../../../../shared/compute/compute-config.ts";
import {
  InvalidComputeNameError,
  InvalidComputeSourceError,
  MissingComputeNameError,
  ComputeDirectoryExistsError,
} from "../../../../shared/compute/compute.errors.ts";
import { computeNew } from "./new.handler.ts";
import { ComputeNewWorkdirError } from "./new.errors.ts";
import type { ComputeNewFlags } from "./new.command.ts";

const CONFIG_WITH_COMMENTS = `# hand-written, and it should stay that way
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

function flags(overrides: Partial<ComputeNewFlags> = {}): ComputeNewFlags {
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

const project = Effect.fnUntraced(function* (files: Readonly<Record<string, string>> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* makeComputeProject({
    "supabase/config.toml": CONFIG_WITH_COMMENTS,
    ...files,
  });
  return {
    dir: repo.dir,
    config: fs.readFileString(path.join(repo.dir, "supabase", "config.toml")),
  };
});

describe("compute new", () => {
  it.live("scaffolds the runtime's starter files and records the choice", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

        const computeDir = path.join(repo.dir, "supabase", "compute", "api");
        expect(yield* fs.exists(path.join(computeDir, "index.mjs"))).toBe(true);
        expect(yield* repo.config).toBe(
          `${CONFIG_WITH_COMMENTS}\n[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
        );

        // Declarative line first, then the detail rows, then the next step —
        // the shape `functions new` established.
        expect(out.stdoutText).toContain("Created new Compute at supabase/compute/api");
        expect(out.stdoutText).toContain("Runtime");
        // The deploy hint is a success trailer, which lands on stderr.
        expect(out.stderrText).toContain("supabase compute push api");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.live("asks for the name when the command line carries none", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        promptTextResponses: ["orders"],
        promptSelectResponses: ["node", "2gb"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.none() }));

        expect(out.promptTextCalls.map((call) => call.message)).toEqual([
          "What should this compute be called?",
        ]);
        expect(
          yield* fs.exists(path.join(repo.dir, "supabase", "compute", "orders", "index.mjs")),
        ).toBe(true);
        expect(yield* repo.config).toContain("[compute.orders]");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The prompt is the last place a mistyped or taken name can be corrected
  // without ending the run, so it refuses both there rather than after asking.
  it.live("refuses a bad or already-recorded name at the name prompt", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({
        "supabase/config.toml": `${CONFIG_WITH_COMMENTS}\n[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
      });
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        promptTextResponses: ["orders"],
        promptSelectResponses: ["node", "2gb"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.none() }));

        const validate = out.promptTextCalls[0]?.opts?.validate;
        expect(validate).toBeDefined();
        expect(validate?.("My_Compute")).toContain("lowercase letters");
        expect(validate?.("api")).toContain("already configured");
        expect(validate?.("orders")).toBeUndefined();
        expect(
          yield* fs.exists(path.join(repo.dir, "supabase", "compute", "orders", "index.mjs")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Nowhere to ask means nothing to scaffold under: the name is the directory,
  // the config key and the hostname, and none of those has a default.
  it.live.each([
    { label: "not interactive", setup: { interactive: false } },
    // A TTY, but stdout was claimed by the payload, so a prompt would corrupt it.
    { label: "-o json", setup: { goOutput: "json" as const } },
    // `printf 'orders\n' | supabase compute new`: stdout is still a
    // terminal, so `output.interactive` on its own would have fed the pipe
    // straight into the name prompt instead of taking this documented path.
    { label: "piped stdin", setup: { stdinIsTty: false } },
  ])("refuses a bare new when there is nowhere to ask ($label)", ({ setup }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        // An answer is waiting, so a prompt would succeed rather than fail some
        // other way.
        promptTextResponses: ["orders"],
        ...setup,
      });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(flags({ name: Option.none() })).pipe(Effect.flip);

        expect(error).toBeInstanceOf(MissingComputeNameError);
        if (!(error instanceof MissingComputeNameError)) {
          return yield* Effect.die("expected MissingComputeNameError");
        }
        // The retry has to name the path the command is actually registered at;
        // `supabase compute new` is an unknown command.
        expect(error.suggestion).toContain("supabase compute new");
        expect(out.promptTextCalls).toEqual([]);
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute"))).toBe(false);
        expect(yield* repo.config).toBe(CONFIG_WITH_COMMENTS);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prompts for runtime, size and exposure when none is given", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        promptSelectResponses: ["node", "4gb", "private"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api") }));

        expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
          "Which runtime should this compute use?",
          "Which instance size should this compute use?",
          "Should this compute be reachable from the internet?",
        ]);
        expect(yield* repo.config).toContain('runtime = "node"');
        expect(yield* repo.config).toContain('size = "4gb"');
        expect(yield* repo.config).toContain('exposure = "private"');
        expect(
          yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api", "index.mjs")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The whole reason `new` records it: `push` sends a complete spec every time,
  // so an entry with no `exposure` is deployed public by the next bare `push`.
  // Recording the answer is what makes a private compute stay private.
  it.live("records the chosen exposure so a later push keeps it", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ exposure: Option.some("private") }));

        expect(yield* repo.config).toContain('exposure = "private"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The count a scaffold cannot guess: `--instances` has no prompt, so it is
  // recorded when given and left out when not.
  it.live("records an instance count that differs from the default", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ instances: Option.some(3) }));

        // Bare, not quoted: the config schema types `instances` as a number, so a
        // quoted count would render a config.toml that no longer loads.
        expect(yield* repo.config).toContain("instances = 3");
        expect(yield* repo.config).not.toContain('instances = "3"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The end-to-end proof that the count is written as a number: the config
  // schema types `instances` as one, so a quoted `"3"` renders a config.toml
  // that no longer decodes — which only shows up on the *next* load, not on the
  // write that caused it. Scaffolding a second compute is that next load.
  it.live("writes a count the config loader can read back", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), instances: Option.some(3) }));
        yield* computeNew(flags({ name: Option.some("web") }));

        expect(yield* repo.config).toContain("instances = 3");
        expect(yield* repo.config).toContain("[compute.web]");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Zero is an explicit count — it scales the compute to nothing — not an absent
  // one, so it has to survive the "only record a non-default" rule.
  it.live("records a zero instance count", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ instances: Option.some(0) }));

        expect(yield* repo.config).toContain("instances = 0");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // An absent `instances` and `instances = 1` mean the same thing to `push`, so
  // the scaffold does not commit a line that says nothing.
  it.live("writes no instance count when nothing names one", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags());

        expect(yield* repo.config).not.toContain("instances");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("writes no instance count when the default is named explicitly", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ instances: Option.some(1) }));

        expect(yield* repo.config).not.toContain("instances");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Written even when it is the default, the same way `runtime` and `size` are:
  // an absent key and `public` mean the same thing to `push` today, but only the
  // written one survives a change of default.
  it.live("records the default exposure when nothing names one", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir, format: "json" });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api") }));

        expect(yield* repo.config).toContain('exposure = "public"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The runtime and size prompts do have defaults to fall back on, so a piped
  // stdin must leave them unasked rather than consuming the pipe.
  it.live("takes the defaults without prompting when stdin is piped", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        stdinIsTty: false,
        promptSelectResponses: ["node", "4gb", "private"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api") }));

        expect(out.promptSelectCalls).toEqual([]);
        expect(yield* repo.config).toContain('runtime = "deno"');
        expect(yield* repo.config).toContain('size = "2gb"');
        expect(yield* repo.config).toContain('exposure = "public"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("falls back to the defaults without prompting when not interactive", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir, format: "json" });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api") }));

        expect(out.promptSelectCalls).toHaveLength(0);
        expect(yield* repo.config).toContain('runtime = "deno"');
        expect(yield* repo.config).toContain('size = "2gb"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A second `new` for the same name is refused rather than re-recorded. Changing
  // a compute that exists is a `config.toml` edit, and the file is the user's.
  it.live("refuses a name that config.toml already records", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("deno"),
            size: Option.some("4gb"),
            exposure: Option.some("public"),
          }),
        );
        const recorded = yield* repo.config;

        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeAlreadyConfiguredError);
        // Refused before anything was asked, and the entry is byte-identical.
        expect(out.promptSelectCalls).toHaveLength(0);
        expect(yield* repo.config).toBe(recorded);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Refused whichever way the entry happens to be written — the decoded config
  // is what answers "does this exist", so no TOML shape matters here.
  it.live.each(['compute.api.runtime = "node"', "[compute.api]"])(
    "refuses an entry recorded as %s",
    (entry) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const config = `project_id = "demo"\n\n${entry}\n`;
        const repo = yield* project({ "supabase/config.toml": config });
        const { layer } = setupCompute({ workdir: repo.dir });

        return yield* Effect.gen(function* () {
          const error = yield* computeNew(
            flags({ name: Option.some("api"), runtime: Option.some("node") }),
          ).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeAlreadyConfiguredError);
          expect(yield* repo.config).toBe(config);
          // Nothing scaffolded either.
          expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api"))).toBe(false);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // CLI-2285 review follow-up: a DEFAULTED workdir's reader (`compute
  // list`/`push`/`status`) can climb to discover a config.json-only ancestor
  // project, but this command's own TOML-only writer never climbs — without
  // an extra check, `new` would silently write a same-named duplicate at the
  // subdirectory instead of refusing it the way it already refuses a
  // duplicate at its own root.
  it.live(
    "refuses a name the reader would discover in a config.json-only ancestor project (defaulted workdir)",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const created = yield* makeComputeProject({
          "supabase/config.json": yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            {
              project_id: "demo",
              compute: { api: { runtime: "node", size: "2gb" } },
            },
          ),
        });
        const sub = path.join(created.dir, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer } = setupCompute({ workdir: sub, explicitWorkdir: false });

        return yield* Effect.gen(function* () {
          const error = yield* computeNew(
            flags({ name: Option.some("api"), runtime: Option.some("deno") }),
          ).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeAlreadyConfiguredError);
          // Nothing was scaffolded at the subdirectory either.
          expect(yield* fs.exists(path.join(sub, "supabase"))).toBe(false);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "does not refuse the same name when --workdir is explicit (writer and reader agree on the same root)",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const created = yield* makeComputeProject({
          "supabase/config.json": yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            {
              project_id: "demo",
              compute: { api: { runtime: "node", size: "2gb" } },
            },
          ),
        });
        const sub = path.join(created.dir, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer } = setupCompute({ workdir: sub, explicitWorkdir: true });

        return yield* Effect.gen(function* () {
          // An explicit workdir never climbs for either the reader or the
          // writer, so the ancestor's config.json is invisible to both — this
          // is the established bare-directory scaffold, unaffected by the fix.
          yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("deno") }));
          expect(yield* fs.exists(path.join(sub, "supabase", "config.toml"))).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("records a --source compute relative to the project root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("node"),
            source: Option.some("packages/api"),
          }),
        );

        expect(yield* fs.exists(path.join(repo.dir, "packages", "api", "index.mjs"))).toBe(true);
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api"))).toBe(false);
        expect(yield* repo.config).toContain('source = "packages/api"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a --source outside the directories a compute may own", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "README.md": "keep me", "src/app.ts": "keep me too" });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        for (const source of [".", "..", "supabase", "supabase/functions"]) {
          const error = yield* computeNew(
            flags({
              name: Option.some("api"),
              runtime: Option.some("node"),
              source: Option.some(source),
            }),
          ).pipe(Effect.flip);

          expect(error).toBeInstanceOf(InvalidComputeSourceError);
        }

        // Nothing was written: the resolver refused before any directory was created.
        expect(yield* fs.exists(path.join(repo.dir, "README.md"))).toBe(true);
        expect(yield* fs.exists(path.join(repo.dir, "src", "app.ts"))).toBe(true);
        expect(yield* repo.config).toContain("project_id");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.live("scaffolds in a directory that has no Supabase project yet", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const created = yield* makeComputeProject();
      const { layer, out } = setupCompute({ workdir: created.dir, explicitWorkdir: true });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

        const computeDir = path.join(created.dir, "supabase", "compute", "api");
        expect(yield* fs.exists(path.join(computeDir, "index.mjs"))).toBe(true);
        expect(yield* fs.readFileString(path.join(created.dir, "supabase", "config.toml"))).toBe(
          `[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
        );
        // An EXPLICIT --workdir has no cwd-relative reading, so the success
        // message names the absolute path rather than a project-root-relative one.
        expect(out.stdoutText).toContain(`Created new Compute at ${computeDir}`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a destination that already has something in it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/compute/api/leftover.txt": "old" });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeDirectoryExistsError);
        expect(
          yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api", "leftover.txt")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Scaffolding into an empty directory is fine — it is only a destination with
  // contents that is refused.
  it.live("scaffolds into a directory that exists but is empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      yield* fs.makeDirectory(path.join(repo.dir, "supabase", "compute", "api"), {
        recursive: true,
      });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

        expect(
          yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api", "index.mjs")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("tells the user how to proceed when the destination is occupied", () =>
    Effect.gen(function* () {
      const repo = yield* project({ "supabase/compute/api/leftover.txt": "old" });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeDirectoryExistsError);
        // No flag to suggest any more, so the advice has to be actionable on its own.
        const suggestion = error instanceof ComputeDirectoryExistsError ? error.suggestion : "";
        expect(suggestion).toContain("Remove");
        expect(suggestion).not.toContain("--force");
        expect(yield* repo.config).toBe(CONFIG_WITH_COMMENTS);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("rejects a name that could not become a hostname", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(flags({ name: Option.some("My_Compute") })).pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(InvalidComputeNameError);
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute"))).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.live("keeps stdout parseable under -o json", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir, goOutput: "json" });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ runtime: Option.some("node") }));

        const payload: unknown = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          out.stdoutText,
        );
        // Every dial the scaffold settled, not just the two it is named for: a
        // caller reading this payload is deciding what to deploy, and an omitted
        // `exposure` or `instances` reads as "unknown" rather than as the default
        // the run actually chose.
        expect(payload).toMatchObject({
          compute_name: "api",
          runtime: "node",
          size: "2gb",
          vcpu: 1,
          exposure: "public",
          instances: 1,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The count and the exposure are recorded sparsely — `instances` is left out
  // of config.toml at the default — so the payload is the only place a caller
  // can read what this scaffold will actually deploy as.
  it.live("reports the chosen exposure and count under -o json", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir, goOutput: "json" });

      return yield* Effect.gen(function* () {
        yield* computeNew(
          flags({
            runtime: Option.some("node"),
            exposure: Option.some("private"),
            instances: Option.some(3),
          }),
        );

        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(out.stdoutText),
        ).toMatchObject({
          exposure: "private",
          instances: 3,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("shows the exposure and declared count in the details block", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(
          flags({
            runtime: Option.some("node"),
            exposure: Option.some("private"),
            instances: Option.some(3),
          }),
        );

        // `Access`, the way `compute status` and `push` label the same field.
        expect(out.stdoutText).toContain("Access");
        expect(out.stdoutText).toContain("private");
        // `declared`, because nothing is running yet — a bare count would read as
        // a live tally.
        expect(out.stdoutText).toContain("3 declared");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Why the config edit is planned before the starter files are written: this
  // failure is knowable up front, and discovering it afterwards would leave a
  // scaffold on disk that nothing records.
  it.live("writes no scaffold at all when the config edit cannot be made", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({
        "supabase/config.toml": 'project_id = "demo"\n\ncompute.api.runtime = "node"\n',
      });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("deno") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeAlreadyConfiguredError);
        // No directory, and config.toml exactly as it was.
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api"))).toBe(false);
        expect(yield* repo.config).toBe('project_id = "demo"\n\ncompute.api.runtime = "node"\n');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The project config loader prefers `supabase/config.json` when one exists,
  // and the entry writer is a TOML text editor. Without `tomlOnly` the two
  // disagree: the plan targets the JSON file and appends a `[compute.api]`
  // table to it, leaving the project config unparseable — after the scaffold is
  // already on disk.
  it.live("leaves config.json alone in a project that has one", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const configJson = `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ project_id: "demo" })}\n`;
      const repo = yield* project({ "supabase/config.json": configJson });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

        const jsonPath = path.join(repo.dir, "supabase", "config.json");
        expect(yield* fs.readFileString(jsonPath)).toBe(configJson);
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* fs.readFileString(jsonPath),
        );
        expect(decoded).toEqual({ project_id: "demo" });

        // The compute is recorded in config.toml, which is the TOML editor's file.
        expect(yield* repo.config).toBe(
          `${CONFIG_WITH_COMMENTS}\n[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n`,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // `settings.workdir` is already an authoritative project root, so the config
  // loader must not climb out of it. Without `search: false` it does: the entry
  // is appended to the *ancestor's* config.toml recording `source =
  // "supabase/compute/api"`, which resolves against the ancestor root to a
  // directory the scaffold never created, while the scaffold itself lands under
  // the workdir. Both sides have to name the same project.
  it.live("records the compute in --workdir's own project, not an ancestor's", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "bare-dir/.keep": "" });
      const workdir = path.join(repo.dir, "bare-dir");
      const { layer } = setupCompute({ workdir });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api"), runtime: Option.some("node") }));

        // The ancestor project is untouched.
        expect(yield* repo.config).toBe(CONFIG_WITH_COMMENTS);
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api"))).toBe(false);

        // The workdir got both the entry and the scaffold it points at.
        expect(yield* fs.readFileString(path.join(workdir, "supabase", "config.toml"))).toBe(
          '[compute.api]\nruntime = "node"\nsize = "2gb"\nexposure = "public"\n',
        );
        expect(
          yield* fs.exists(path.join(workdir, "supabase", "compute", "api", "index.mjs")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A sealed inline `[compute]` cannot be extended by appending a table, and
  // the name is absent from the decoded section, so the already-configured
  // check does not fire. Parsing the plan is what refuses it — before the
  // scaffold is written, like every other refusal here.
  it.live("writes no scaffold when [compute] is a sealed inline table", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const before = 'project_id = "demo"\n\ncompute = { web = { runtime = "node" } }\n';
      const repo = yield* project({ "supabase/config.toml": before });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeConfigWriteUnsafeError);
        expect(yield* fs.exists(path.join(repo.dir, "supabase", "compute", "api"))).toBe(false);
        expect(yield* repo.config).toBe(before);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A plain file must not read as an empty directory: that fails with a bare
  // EEXIST from `makeDirectory` instead of naming what is in the way.
  it.live("refuses a plain file at the destination", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "supabase/compute/api": "not a directory" });
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({ name: Option.some("api"), runtime: Option.some("node") }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ComputeDirectoryExistsError);
        expect(yield* fs.readFileString(path.join(repo.dir, "supabase", "compute", "api"))).toBe(
          "not a directory",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A relative `--source` is something typed at a shell prompt, so it means
  // what it would mean to the shell: relative to where you are.
  it.live("resolves a relative --source against the directory it was typed in", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* project({ "apps/web/.keep": "" });
      const { layer } = setupCompute({
        workdir: repo.dir,
        cwd: path.join(repo.dir, "apps", "web"),
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("node"),
            source: Option.some("generated"),
          }),
        );

        expect(yield* fs.exists(path.join(repo.dir, "apps", "web", "generated", "index.mjs"))).toBe(
          true,
        );
        expect(yield* fs.exists(path.join(repo.dir, "generated"))).toBe(false);
        // Persisted project-root-relative, with forward slashes on every platform.
        expect(yield* repo.config).toContain('source = "apps/web/generated"');
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // Clack writes its prompt UI to stdout with no stream override, and `-o json`
  // leaves `output.format` as `text` — so a prompt lands in front of the payload
  // exactly as the notices did.
  it.live("does not prompt under -o json, so stdout stays parseable", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer, out } = setupCompute({
        workdir: repo.dir,
        goOutput: "json",
        // Answers are available, so a prompt would succeed and corrupt stdout
        // rather than fail the test some other way.
        promptSelectResponses: ["node", "4gb"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew(flags({ name: Option.some("api") }));

        const payload: unknown = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          out.stdoutText,
        );
        // The defaults stand, because there was nowhere to ask.
        expect(payload).toMatchObject({ runtime: "deno", size: "2gb" });
        expect(out.promptSelectCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The prompts only ever offer values this CLI knows, so an unrecognized answer
  // means the prompt layer handed back something off-menu. Recording it verbatim
  // would put a runtime into config.toml that `push` then refuses; the default
  // is the one answer that still scaffolds something deployable.
  it.live("falls back to the defaults when a prompt answers off-menu", () =>
    Effect.gen(function* () {
      const repo = yield* project();
      const { layer } = setupCompute({
        workdir: repo.dir,
        promptSelectResponses: ["cobol", "colossal", "sideways"],
      });

      return yield* Effect.gen(function* () {
        yield* computeNew({
          name: Option.some("api"),
          runtime: Option.none(),
          size: Option.none(),
          exposure: Option.none(),
          instances: Option.none(),
          source: Option.none(),
        });

        expect(yield* repo.config).toContain(`runtime = "deno"`);
        expect(yield* repo.config).toContain(`size = "2gb"`);
        expect(yield* repo.config).toContain(`exposure = "public"`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses --source pointed at the project config file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repo = yield* project();
      const { layer } = setupCompute({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        const error = yield* computeNew(
          flags({
            name: Option.some("api"),
            runtime: Option.some("node"),
            source: Option.some(path.join("supabase", "config.toml")),
          }),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidComputeSourceError);
        // The config survived, which is the whole point.
        expect(yield* repo.config).toBe(CONFIG_WITH_COMMENTS);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // CLI-2285 regression: before this fix, a typo'd/nonexistent --workdir
  // reached `fs.makeDirectory(destination, { recursive: true })` below with no
  // prior existence check, silently scaffolding a fresh
  // supabase/compute/<name>/ tree (plus a new config.toml) at the wrong path.
  // `validateWorkdirIsDirectory` must now fail first, before anything on
  // disk changes.
  it.live(
    "fails without scaffolding anything when --workdir names a directory that does not exist at all",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* project();
        const badWorkdir = path.join(repo.dir, "does-not-exist");
        const { layer } = setupCompute({ workdir: badWorkdir, explicitWorkdir: true });

        return yield* Effect.gen(function* () {
          const error = yield* computeNew(flags()).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ComputeNewWorkdirError);
          expect(error).toMatchObject({
            message: expect.stringContaining("failed to change workdir: chdir"),
          });

          // The critical safety assertion: nothing was scaffolded at the bad
          // path, and the ancestor project's own config is untouched.
          expect(yield* fs.exists(path.join(badWorkdir, "supabase"))).toBe(false);
          expect(yield* repo.config).toBe(CONFIG_WITH_COMMENTS);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
