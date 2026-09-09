// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForBackend } from "../../../cli/root.ts";
import { StackRoutingError, resolveStackBackend } from "./stack-backend.ts";

const resolve = (input: Parameters<typeof resolveStackBackend>[0]) =>
  resolveStackBackend(input).pipe(Effect.provide(BunServices.layer));

const project = (config: string) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-routing-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), config);
  return root;
};

const completionFlags = (backend: "legacy" | "stack", command: string) =>
  respondToComplete(rootCommandForBackend(backend), ["__complete", command, "--"])?.candidates.map(
    ({ name }) => name,
  );

describe("resolveStackBackend", () => {
  it.effect("selects the explicit stack namespace without config or env", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["stack", "start"], cwd: "/missing", env: {} })).toBe("stack");
    }),
  );

  it.effect("selects the configured backend for top-level start and stop", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["start"], cwd: join(root, "nested"), env: {} })).toBe("stack");
      expect(yield* resolve({ args: ["stop"], cwd: root, env: {} })).toBe("stack");
      expect(yield* resolve({ args: ["status"], cwd: root, env: {} })).toBe("legacy");
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("routes command-specific start completion through the selected backend", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
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
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("uses the environment override before reading config", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
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
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("rejects invalid overrides and bypasses malformed config", () => {
    const root = project("[experimental\nstack = true\n");
    return Effect.gen(function* () {
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
      expect(
        yield* resolve({
          args: ["stack", "start"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK: "invalid" },
        }),
      ).toBe("stack");
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("honors explicit workdir and separated global boolean values", () => {
    const stackRoot = project("[experimental]\nstack = true\n");
    const legacyRoot = project("[experimental]\nstack = false\n");
    return Effect.gen(function* () {
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
      expect(yield* resolve({ args: ["--debug", "false", "start"], cwd: stackRoot, env: {} })).toBe(
        "stack",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(stackRoot, { recursive: true, force: true });
          rmSync(legacyRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports malformed routing config as a typed error", () => {
    const root = project('[experimental]\nstack = "yes"\n');
    return Effect.gen(function* () {
      const exit = yield* resolve({ args: ["start"], cwd: root, env: {} }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(StackRoutingError);
        }
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("ignores the completion cursor until a command path is complete", () => {
    const root = project("[experimental\nstack = true\n");
    return Effect.gen(function* () {
      expect(
        yield* resolve({
          args: ["__complete", "sta"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK: "invalid" },
        }),
      ).toBe("legacy");
      expect(
        yield* resolve({
          args: ["__completeNoDesc", "start"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_STACK: "invalid" },
        }),
      ).toBe("legacy");

      const invalid = yield* resolve({
        args: ["__complete", "start", "--"],
        cwd: root,
        env: {},
      }).pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      if (Exit.isFailure(invalid)) {
        const error = Cause.findErrorOption(invalid.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(StackRoutingError);
          expect(String(error.value)).toContain("Unable to parse");
        }
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
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

  it("keeps status and workers on their existing command trees", () => {
    for (const backend of ["legacy", "stack"] as const) {
      const stackCommands = respondToComplete(rootCommandForBackend(backend), [
        "__complete",
        "stack",
        "",
      ])?.candidates.map(({ name }) => name);
      expect(stackCommands).toEqual(["start", "stop"]);

      const experimentalCommands = respondToComplete(rootCommandForBackend(backend), [
        "__complete",
        "experimental",
        "",
      ])?.candidates.map(({ name }) => name);
      expect(experimentalCommands).toContain("workers");
      expect(experimentalCommands).not.toContain("stack");

      expect(completionFlags(backend, "status")).toContain("--override-name");
    }
  });
});
