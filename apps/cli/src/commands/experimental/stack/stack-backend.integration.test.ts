import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Effect, Exit, FileSystem, Option, Path } from "effect";
import {
  ExperimentalFeatureFlagError,
  WarnedExperimentalDeprecations,
} from "../../../shared/config/experimental-feature.ts";
import { readLinkSnapshot } from "../../../shared/config/link-snapshot.ts";
import { projectStateModeLayer } from "../../../shared/config/project-state-mode.ts";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import {
  type StackBackend,
  StackRoutingError,
  resolveProjectStateSelection,
} from "../../../command-internal/stack-backend.ts";
import { withConfigEnv } from "../../../../tests/helpers/command-mocks.ts";
import { fakeConsole } from "../../../../tests/helpers/mocks.ts";

const select = ({
  env,
  ...input
}: Parameters<typeof resolveProjectStateSelection>[0] & {
  readonly env: Readonly<Record<string, string>>;
}) =>
  withConfigEnv(env, resolveProjectStateSelection(input)).pipe(Effect.provide(BunServices.layer));

const resolve = (input: Parameters<typeof select>[0]) =>
  select(input).pipe(Effect.map(({ stackBackend }) => stackBackend));

const project = (config: string, format: "toml" | "json" = "toml") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-routing-" });
    yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(root, "supabase", `config.${format}`), config);
    return root;
  });

const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(BunServices.layer));

const completionFlags = (backend: StackBackend | undefined, command: string) =>
  respondToComplete(rootCommandForFeatures({ stackBackend: backend }), [
    "__complete",
    command,
    "--",
  ])?.candidates.map(({ name }) => name);

const resolveWithWarnings = (input: Parameters<typeof select>[0]) => {
  const { console, calls } = fakeConsole();
  return resolve(input).pipe(
    Effect.provideService(Console.Console, console),
    Effect.provideService(WarnedExperimentalDeprecations, new Set()),
    Effect.map((backend) => ({ backend, calls })),
  );
};

describe("deprecated stack switches", () => {
  it.effect("enables the stack from the old env name and warns on stderr", () =>
    Effect.gen(function* () {
      const { backend, calls } = yield* resolveWithWarnings({
        args: ["start"],
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
      });
      expect(backend).toBe("stack");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(
        /^error:.*SUPABASE_EXPERIMENTAL_STACK.*SUPABASE_EXPERIMENTAL_STACK_ENABLED/,
      );
    }),
  );

  it.effect("enables the stack from the old config form and warns on stderr", () =>
    withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental]\nstack = true\n");
        const { backend, calls } = yield* resolveWithWarnings({
          args: ["start"],
          cwd: root,
          env: {},
        });
        expect(backend).toBe("stack");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/^error:.*experimental\.stack = true.*\[experimental\.stack\]/);
      }),
    ),
  );

  it.effect("prefers the new env name over the old one without warning", () =>
    Effect.gen(function* () {
      const { backend, calls } = yield* resolveWithWarnings({
        args: ["start"],
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "0", SUPABASE_EXPERIMENTAL_STACK: "1" },
      });
      expect(backend).toBe("legacy");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("reads the new config form without a warning", () =>
    withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = false\n");
        const { backend, calls } = yield* resolveWithWarnings({
          args: ["start"],
          cwd: root,
          env: {},
        });
        expect(backend).toBe("legacy");
        expect(calls).toEqual([]);
      }),
    ),
  );
});

describe("resolveProjectStateSelection", () => {
  it.effect("keeps the explicit stack namespace disabled without the feature flag", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["stack", "start"], cwd: "/missing", env: {} })).toBe("legacy");
    }),
  );

  it.effect("selects the configured backend for managed local commands", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project(`project_id = "stack-routing-test"
[api]
port = 55421
[db]
port = 55422
[auth]
enabled = true
[experimental.webhooks]
enabled = true
[experimental.stack]
enabled = true
`);
        const path = yield* Path.Path;
        expect(yield* resolve({ args: ["start"], cwd: path.join(root, "nested"), env: {} })).toBe(
          "stack",
        );
        expect(yield* resolve({ args: ["stop"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["status"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["db", "diff"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["db", "test"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["test", "db"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["migration", "squash"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["pull"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["gen", "types"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["inspect", "db"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["storage", "ls"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["seed", "buckets"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["services"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["issues"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["logs"], cwd: root, env: {} })).toBeUndefined();
        expect(yield* resolve({ args: ["logs", "sources"], cwd: root, env: {} })).toBeUndefined();
      }),
    );
  });

  it.effect.each([
    ["logs", "--service", "--sql"],
    ["logs", "--search=--file"],
    ["logs", "--remote"],
    ["logs", "sources"],
    ["help", "logs"],
    ["__complete", "logs", "--"],
  ])("defers local logs feature validation until after parsing %j", (args) =>
    Effect.gen(function* () {
      const selection = yield* select({
        args,
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "invalid" },
      });
      expect(selection.stackBackend).toBeUndefined();
      expect(selection.projectState?._tag).toBe("Failure");
    }),
  );

  it.effect("keeps storage on legacy when the feature flag is disabled", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        expect(
          yield* resolve({
            args: ["storage", "ls"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "0" },
          }),
        ).toBe("legacy");
        for (const args of [["logs"], ["logs", "sources"]]) {
          expect(
            yield* resolve({
              args,
              cwd: root,
              env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "0" },
            }),
          ).toBeUndefined();
        }
      }),
    );
  });

  it.effect("selects no backend for an unrouted command when stack is enabled", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        expect(yield* resolve({ args: ["link"], cwd: root, env: {} })).toBeUndefined();
        expect(
          yield* resolve({ args: ["logs", "--remote", "--sql", "select 1"], cwd: root, env: {} }),
        ).toBeUndefined();
      }),
    );
  });

  it.effect("routes command-specific start completion through the selected backend", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        const backend = yield* resolve({
          args: ["__complete", "start", "--"],
          cwd: root,
          env: {},
        });
        expect(backend).toBe("stack");
        expect(completionFlags(backend, "start")).toEqual(
          expect.arrayContaining(["--stack", "--runtime"]),
        );
        expect(completionFlags(backend, "start")).not.toContain("--ignore-health-check");
      }),
    );
  });

  it.effect("uses the environment override before reading config", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "0" },
          }),
        ).toBe("legacy");
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "" },
          }),
        ).toBe("stack");
      }),
    );
  });

  it.effect("reads TOML and JSON config when no environment override is set", () => {
    const cases = [
      ["toml", "[experimental.stack]\nenabled = true\n", "stack"],
      ["toml", "[experimental.stack]\nenabled = false\n", "legacy"],
      ["json", JSON.stringify({ experimental: { stack: true } }), "stack"],
      ["json", JSON.stringify({ experimental: { stack: false } }), "legacy"],
    ] as const;
    return withServices(
      Effect.gen(function* () {
        for (const [format, config, expected] of cases) {
          const root = yield* project(config, format);
          yield* resolve({ args: ["start"], cwd: root, env: {} }).pipe(
            Effect.tap((backend) => Effect.sync(() => expect(backend).toBe(expected))),
          );
        }
      }),
    );
  });

  it.effect("ignores an invalid compute setting when reading stack", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project(
          '[experimental]\ncompute = "yes"\n\n[experimental.stack]\nenabled = true\n',
        );
        expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("stack");
      }),
    );
  });

  it.effect("prefers config.json when both config formats exist", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = false\n");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(root, "supabase", "config.json"),
          '{"experimental":{"stack":{"enabled":true}}}',
        );
        expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("stack");
      }),
    );
  });

  it.effect("reads experimental.stack from a commented config.jsonc", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = false\n");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(root, "supabase", "config.jsonc"),
          '{\n  // opt in\n  "experimental": { "stack": { "enabled": true, }, },\n}\n',
        );
        expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("stack");
      }),
    );
  });

  it.effect("rejects invalid overrides and bypasses malformed config", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental\nstack = true\n");
        const invalid = yield* resolve({
          args: ["start"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "yes" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) {
          const error = Cause.findErrorOption(invalid.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackRoutingError);
            expect(String(error.value)).toContain("expected true or false");
          }
        }
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "1" },
          }),
        ).toBe("stack");
        const explicit = yield* resolve({
          args: ["stack", "start"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "invalid" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(explicit)).toBe(true);
      }),
    );
  });

  it.effect("keeps an invalid environment value from failing an unrouted command", () =>
    withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        const selection = yield* select({
          args: ["login"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "garbage" },
        });
        expect(selection.stackBackend).toBeUndefined();
        expect(selection.projectState).toBeDefined();
      }),
    ),
  );

  it.effect("fails a link-state read with the typed error once the mode is invalid", () =>
    withServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        const selection = yield* select({
          args: ["link"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "garbage" },
        });
        if (selection.projectState === undefined) return yield* Effect.die("no selection");

        const read = yield* readLinkSnapshot(fs, path, root).pipe(
          Effect.map((snapshot) => snapshot.ref),
          Effect.provide(projectStateModeLayer(selection.projectState)),
          Effect.flip,
        );
        expect(read).toBeInstanceOf(ExperimentalFeatureFlagError);
      }),
    ),
  );

  it.effect("honors explicit workdir and separated global boolean values", () => {
    return withServices(
      Effect.gen(function* () {
        const stackRoot = yield* project("[experimental.stack]\nenabled = true\n");
        const legacyRoot = yield* project("[experimental.stack]\nenabled = false\n");
        expect(
          yield* resolve({
            args: ["--workdir", legacyRoot, "start"],
            cwd: stackRoot,
            env: { SUPABASE_WORKDIR: stackRoot },
          }),
        ).toBe("legacy");
        expect(
          yield* resolve({
            args: [`--workdir=${legacyRoot}`, "start"],
            cwd: stackRoot,
            env: { SUPABASE_WORKDIR: stackRoot },
          }),
        ).toBe("legacy");
        expect(
          yield* resolve({ args: ["--debug", "false", "start"], cwd: stackRoot, env: {} }),
        ).toBe("stack");
        expect(yield* resolve({ args: ["-yo", "json", "start"], cwd: stackRoot, env: {} })).toBe(
          "stack",
        );
        expect(yield* resolve({ args: ["-ho", "json", "start"], cwd: stackRoot, env: {} })).toBe(
          "stack",
        );
      }),
    );
  });

  it.effect("falls back to legacy routing when the config cannot be read or decoded", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project('[experimental.stack]\nenabled = "yes"\n');
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const unreadableRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-routing-unreadable-",
        });
        yield* fs.makeDirectory(path.join(unreadableRoot, "supabase", "config.toml"), {
          recursive: true,
        });
        expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("legacy");
        expect(yield* resolve({ args: ["start"], cwd: unreadableRoot, env: {} })).toBe("legacy");
      }),
    );
  });

  it.effect("routes root, explicit help, and completion through the feature flag", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        for (const args of [
          [],
          ["--help"],
          ["help", "start"],
          ["help", "status"],
          ["help", "stop"],
          ["help", "stack"],
          ["stack", "--help"],
          ["__complete", "st"],
          ["__complete", "start", "--"],
          ["__complete", "status", "--"],
        ]) {
          expect(yield* resolve({ args, cwd: root, env: {} })).toBe("stack");
        }
      }),
    );
  });

  it.effect("handles completion cursors while resolving the selected backend", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental\nstack = true\n");
        for (const args of [
          ["__complete", "sta"],
          ["__completeNoDesc", "start"],
        ]) {
          const invalid = yield* resolve({
            args,
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK_ENABLED: "invalid" },
          }).pipe(Effect.exit);
          expect(Exit.isFailure(invalid)).toBe(true);
        }

        const backend = yield* resolve({
          args: ["__complete", "start", "--"],
          cwd: root,
          env: {},
        });
        expect(backend).toBe("legacy");
      }),
    );
  });

  it.effect("routes only functions serve through the selected Stack backend", () =>
    withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental.stack]\nenabled = true\n");
        expect(yield* resolve({ args: ["functions", "serve"], cwd: root, env: {} })).toBe("stack");
        expect(yield* resolve({ args: ["help", "functions", "serve"], cwd: root, env: {} })).toBe(
          "stack",
        );
        expect(
          yield* resolve({ args: ["__complete", "functions", "serve", "--"], cwd: root, env: {} }),
        ).toBe("stack");
        expect(yield* resolve({ args: ["functions", "list"], cwd: root, env: {} })).toBeUndefined();
      }),
    ),
  );

  it("selects matching command trees for completion", () => {
    expect(completionFlags("stack", "start")).toEqual(
      expect.arrayContaining(["--stack", "--runtime", "--preparation", "--eager"]),
    );
    expect(completionFlags("legacy", "start")).toEqual(
      expect.arrayContaining(["--exclude", "--ignore-health-check"]),
    );
    expect(completionFlags("stack", "start")).not.toContain("--ignore-health-check");
  });

  it("gates the stack command tree while preserving status completion", () => {
    const disabledRoot = respondToComplete(rootCommandForFeatures({ stackBackend: "legacy" }), [
      "__complete",
      "",
    ]);
    expect(disabledRoot?.candidates.map(({ name }) => name)).not.toContain("stack");
    const enabledRoot = respondToComplete(rootCommandForFeatures({ stackBackend: "stack" }), [
      "__complete",
      "",
    ]);
    expect(enabledRoot?.candidates.map(({ name }) => name)).toContain("stack");

    for (const backend of ["legacy", "stack"] as const) {
      const stackCommands = respondToComplete(rootCommandForFeatures({ stackBackend: backend }), [
        "__complete",
        "stack",
        "",
      ])?.candidates.map(({ name }) => name);
      expect(stackCommands).toEqual(
        backend === "stack"
          ? [
              "destroy",
              "install",
              "list",
              "logs",
              "outdated",
              "prune",
              "restart",
              "start",
              "status",
              "stop",
              "update",
            ]
          : [],
      );
    }
    expect(completionFlags("stack", "status")).toContain("--override-name");
    expect(completionFlags("stack", "status")).toContain("--env");
    expect(completionFlags("stack", "status")).toContain("--stack");
    expect(completionFlags("legacy", "status")).not.toContain("--stack");
    expect(completionFlags("legacy", "status")).not.toContain("--env");
  });
});
