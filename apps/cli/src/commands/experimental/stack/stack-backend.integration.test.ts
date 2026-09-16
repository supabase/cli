import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import { StackRoutingError, resolveStackBackend } from "../../../command-internal/stack-backend.ts";

const resolve = (input: Parameters<typeof resolveStackBackend>[0]) =>
  resolveStackBackend(input).pipe(Effect.provide(BunServices.layer));

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

const completionFlags = (backend: "legacy" | "stack", command: string) =>
  respondToComplete(rootCommandForFeatures({ stackBackend: backend }), [
    "__complete",
    command,
    "--",
  ])?.candidates.map(({ name }) => name);

describe("resolveStackBackend", () => {
  it.effect("keeps the explicit stack namespace disabled without the feature flag", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["stack", "start"], cwd: "/missing", env: {} })).toBe("legacy");
    }),
  );

  it.effect("selects the configured backend for top-level start, stop, and status", () => {
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
[experimental]
stack = true
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
      }),
    );
  });

  it.effect("routes command-specific start completion through the selected backend", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental]\nstack = true\n");
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
        const root = yield* project("[experimental]\nstack = true\n");
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK: "0" },
          }),
        ).toBe("legacy");
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK: "" },
          }),
        ).toBe("stack");
      }),
    );
  });

  it.effect("reads TOML and JSON config when no environment override is set", () => {
    const cases = [
      ["toml", "[experimental]\nstack = true\n", "stack"],
      ["toml", "[experimental]\nstack = false\n", "legacy"],
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
        const root = yield* project('[experimental]\nstack = true\ncompute = "yes"\n');
        expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("stack");
      }),
    );
  });

  it.effect("prefers config.json when both config formats exist", () => {
    return withServices(
      Effect.gen(function* () {
        const root = yield* project("[experimental]\nstack = false\n");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(root, "supabase", "config.json"),
          '{"experimental":{"stack":true}}',
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
          env: { SUPABASE_EXPERIMENTAL_STACK: "yes" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) {
          const error = Cause.findErrorOption(invalid.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackRoutingError);
            expect(String(error.value)).toContain("0 or 1");
          }
        }
        expect(
          yield* resolve({
            args: ["start"],
            cwd: root,
            env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          }),
        ).toBe("stack");
        const explicit = yield* resolve({
          args: ["stack", "start"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK: "invalid" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(explicit)).toBe(true);
      }),
    );
  });

  it.effect("honors explicit workdir and separated global boolean values", () => {
    return withServices(
      Effect.gen(function* () {
        const stackRoot = yield* project("[experimental]\nstack = true\n");
        const legacyRoot = yield* project("[experimental]\nstack = false\n");
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
        const root = yield* project('[experimental]\nstack = "yes"\n');
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
        const root = yield* project("[experimental]\nstack = true\n");
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
            env: { SUPABASE_EXPERIMENTAL_STACK: "invalid" },
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
          ? ["destroy", "list", "logs", "prepare", "restart", "start", "status", "stop"]
          : [],
      );
    }
    expect(completionFlags("stack", "status")).toContain("--override-name");
    expect(completionFlags("stack", "status")).toContain("--env");
    expect(completionFlags("stack", "status")).toContain("--stack-id");
    expect(completionFlags("legacy", "status")).not.toContain("--stack-id");
    expect(completionFlags("legacy", "status")).not.toContain("--env");
  });
});
