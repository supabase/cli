// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temporary project fixture
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { legacyRespondToComplete } from "../../../cli/legacy-complete.ts";
import { legacyRootForBackend } from "../../../cli/root.ts";
import {
  LegacyExperimentalStackRoutingError,
  legacyResolveExperimentalStackBackend,
} from "./stack-backend.ts";

const resolve = (input: Parameters<typeof legacyResolveExperimentalStackBackend>[0]) =>
  legacyResolveExperimentalStackBackend(input).pipe(Effect.provide(BunServices.layer));

const project = (config: string, format: "toml" | "json" = "toml") => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-routing-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(join(root, "supabase", `config.${format}`), config);
  return root;
};

describe("legacyResolveExperimentalStackBackend", () => {
  it.effect("selects the stack backend for the canonical namespace without config", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["stack", "--help"], cwd: "/missing", env: {} })).toBe("stack");
    }),
  );

  it.effect("selects the configured backend for top-level lifecycle aliases", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["start"], cwd: join(root, "nested"), env: {} })).toBe("stack");
      expect(yield* resolve({ args: ["status"], cwd: root, env: {} })).toBe("stack");
      expect(yield* resolve({ args: ["start", "--workdir", "nested"], cwd: root, env: {} })).toBe(
        "legacy",
      );
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("treats a separated global boolean value as a flag value", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
      for (const flag of ["--debug", "--experimental", "--yes", "--create-ticket"])
        for (const value of ["false", "0", "no", "off"])
          expect(yield* resolve({ args: [flag, value, "start"], cwd: root, env: {} })).toBe(
            "stack",
          );
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("offers flags from the selected command tree after a separated boolean", () => {
    const root = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
      const backend = yield* resolve({
        args: ["--debug", "false", "start", "--help"],
        cwd: root,
        env: {},
      });
      expect(backend).toBe("stack");
      const completion = legacyRespondToComplete(legacyRootForBackend(backend), [
        "__complete",
        "start",
        "--",
      ]);
      expect(completion?.candidates.map((candidate) => candidate.name)).toContain("--runtime");
      expect(completion?.candidates.map((candidate) => candidate.name)).not.toContain(
        "--ignore-health-check",
      );
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("matches handler workdir selection and first repeated workdir", () => {
    const stackRoot = project("[experimental]\nstack = true\n");
    const legacyRoot = project("[experimental]\nstack = false\n");
    const nested = join(stackRoot, "nested");
    mkdirSync(join(nested, "child"), { recursive: true });
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["start"], cwd: stackRoot, env: {} })).toBe("stack");
      expect(yield* resolve({ args: ["start"], cwd: nested, env: {} })).toBe("stack");
      expect(
        yield* resolve({
          args: ["--workdir", stackRoot, "--workdir", legacyRoot, "start"],
          cwd: nested,
          env: {},
        }),
      ).toBe("stack");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(stackRoot, { recursive: true, force: true });
          rmSync(legacyRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not treat a consumed profile value as workdir", () => {
    const root = project("[experimental]\nstack = true\n");
    return resolve({ args: ["--profile", "--workdir=missing", "start"], cwd: root, env: {} }).pipe(
      Effect.tap((backend) => Effect.sync(() => expect(backend).toBe("stack"))),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("ignores JSON-only projects and supports both completion modes", () => {
    const root = project('{"experimental":{"stack":true}}', "json");
    return Effect.gen(function* () {
      for (const mode of ["__complete", "__completeNoDesc"]) {
        const backend = yield* resolve({ args: [mode, "start", "--"], cwd: root, env: {} });
        expect(backend).toBe("legacy");
        const response = legacyRespondToComplete(legacyRootForBackend(backend), [
          mode,
          "start",
          "--",
        ]);
        expect(response?.candidates.map(({ name }) => name)).toContain("--ignore-health-check");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("uses config.toml when JSON and TOML settings conflict", () => {
    const root = project("[experimental]\nstack = false\n");
    writeFileSync(join(root, "supabase", "config.json"), '{"experimental":{"stack":true}}');
    return resolve({ args: ["start"], cwd: root, env: {} }).pipe(
      Effect.tap((backend) => Effect.sync(() => expect(backend).toBe("legacy"))),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps the legacy backend when the setting is false", () => {
    const root = project("[experimental]\nstack = false\n");
    return resolve({ args: ["stop"], cwd: root, env: {} }).pipe(
      Effect.tap((backend) => Effect.sync(() => expect(backend).toBe("legacy"))),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps lifecycle commands legacy without an opt-in", () => {
    const root = project('project_id = "routing"\n');
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["start"], cwd: root, env: {} })).toBe("legacy");
      expect(yield* resolve({ args: ["stop"], cwd: join(root, "nested"), env: {} })).toBe("legacy");
      expect(
        yield* resolve({ args: ["status", "--workdir", join(root, "nested")], cwd: root, env: {} }),
      ).toBe("legacy");
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("bypasses config for unrelated commands and the canonical stack command", () => {
    const root = project("[experimental\nstack = true\n");
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["login"], cwd: root, env: {} })).toBe("legacy");
      expect(yield* resolve({ args: ["--version", "start"], cwd: root, env: {} })).toBe("legacy");
      expect(yield* resolve({ args: ["stack", "start"], cwd: root, env: {} })).toBe("stack");
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("honors explicit workdir over env and lets an empty flag use env", () => {
    const legacyRoot = project("[experimental]\nstack = false\n");
    const stackRoot = project("[experimental]\nstack = true\n");
    return Effect.gen(function* () {
      expect(
        yield* resolve({
          args: ["start", "--workdir", legacyRoot],
          cwd: stackRoot,
          env: { SUPABASE_WORKDIR: stackRoot },
        }),
      ).toBe("legacy");
      expect(
        yield* resolve({
          args: ["--workdir=", "start"],
          cwd: legacyRoot,
          env: { SUPABASE_WORKDIR: stackRoot },
        }),
      ).toBe("stack");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(legacyRoot, { recursive: true, force: true });
          rmSync(stackRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports an invalid routing value as a typed configuration error", () => {
    const root = project('[experimental]\nstack = "yes"\n');
    return Effect.gen(function* () {
      const exit = yield* resolve({ args: ["start"], cwd: root, env: {} }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error))
          expect(error.value).toBeInstanceOf(LegacyExperimentalStackRoutingError);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("reports malformed config syntax as a typed configuration error", () => {
    const root = project("[experimental\nstack = true\n");
    return Effect.gen(function* () {
      const exit = yield* resolve({ args: ["start"], cwd: root, env: {} }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error))
          expect(error.value).toBeInstanceOf(LegacyExperimentalStackRoutingError);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });
});
