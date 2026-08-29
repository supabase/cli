import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { StackMustBeStoppedError, StackSecretMismatchError } from "../public/Errors.ts";
import { compileStack } from "../model/Compiler.ts";
import { redactKnownSecrets, resolveSecrets, type SecretCandidate } from "./SecretStore.ts";

const layer = NodeServices.layer;
const managed = (value?: string): SecretCandidate => ({
  declarations: [
    {
      slot: "managed:db",
      policy: "managed",
      value: value === undefined ? undefined : Redacted.make(value),
    },
  ],
});
const passthrough = (slot: string, value: string): SecretCandidate => ({
  declarations: [{ slot, policy: "passthrough", value: Redacted.make(value) }],
});
const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("managed and pass-through secrets", () => {
  it.live("generates managed omissions once and reuses them", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed(), undefined, "stopped");
      const second = yield* resolveSecrets(managed(), first.persisted, "running");
      expect(second.persisted["managed:db"]?.value).toBe(first.persisted["managed:db"]?.value);
      expect(second.persisted["managed:db"]?.value).not.toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates and reuses every compiler-required managed slot", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/project",
        runtime: { kind: "native" },
      });
      const candidate = { declarations: compiled.secrets };
      const first = yield* resolveSecrets(candidate, undefined, "stopped");
      const second = yield* resolveSecrets(candidate, first.persisted, "running");
      for (const slot of [
        "secret:database.internal.password",
        "secret:auth.settings.publishable_key",
        "secret:auth.settings.secret_key",
      ]) {
        expect(first.persisted[slot]?.policy).toBe("managed");
        expect(first.persisted[slot]?.value).toBe(second.persisted[slot]?.value);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("rejects a conflicting managed value in stopped and running states", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed("original"), undefined, "stopped");
      for (const lifecycle of ["stopped", "running"] as const) {
        const exit = yield* resolveSecrets(managed("different"), first.persisted, lifecycle).pipe(
          Effect.exit,
        );
        expect(errorOf(exit)).toBeInstanceOf(StackSecretMismatchError);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("allows complete pass-through add, replacement, and removal only while stopped", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(passthrough("pass:smtp", "old"), undefined, "stopped");
      const replacement = yield* resolveSecrets(
        passthrough("pass:smtp", "new"),
        first.persisted,
        "stopped",
      );
      expect(replacement.persisted["pass:smtp"]?.value).toBe("new");
      const removed = yield* resolveSecrets({ declarations: [] }, replacement.persisted, "stopped");
      expect(removed.persisted["pass:smtp"]).toBeUndefined();
      const running = yield* resolveSecrets(
        { declarations: [] },
        replacement.persisted,
        "running",
      ).pipe(Effect.exit);
      expect(errorOf(running)).toBeInstanceOf(StackMustBeStoppedError);
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    "rejects pass-through additions, replacements, and removals while running or destroying",
    () =>
      Effect.gen(function* () {
        const existing = yield* resolveSecrets(
          passthrough("pass:smtp", "old"),
          undefined,
          "stopped",
        );
        for (const lifecycle of ["running", "destroying"] as const) {
          const added = yield* resolveSecrets(
            passthrough("pass:new", "value"),
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(added)).toBeInstanceOf(StackMustBeStoppedError);
          const replaced = yield* resolveSecrets(
            passthrough("pass:smtp", "new"),
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(replaced)).toBeInstanceOf(StackMustBeStoppedError);
          const removed = yield* resolveSecrets(
            { declarations: [] },
            existing.persisted,
            lifecycle,
          ).pipe(Effect.exit);
          expect(errorOf(removed)).toBeInstanceOf(StackMustBeStoppedError);
          const unchanged = yield* resolveSecrets(
            passthrough("pass:smtp", "old"),
            existing.persisted,
            lifecycle,
          );
          expect(unchanged.persisted["pass:smtp"]?.value).toBe("old");
        }
      }).pipe(Effect.provide(layer)),
  );

  it.live("does not include secret bytes in mismatch errors or redaction output", () =>
    Effect.gen(function* () {
      const first = yield* resolveSecrets(managed("top-secret"), undefined, "stopped");
      const exit = yield* resolveSecrets(managed("other-secret"), first.persisted, "stopped").pipe(
        Effect.exit,
      );
      const error = errorOf(exit);
      expect(String(error)).not.toContain("top-secret");
      expect(String(error)).not.toContain("other-secret");
    }).pipe(Effect.provide(layer)),
  );

  it("redacts overlapping known values longest-first", () => {
    expect(redactKnownSecrets("token=abc123; short=abc", ["abc", "abc123", "abc", ""])).toBe(
      "token=[REDACTED]; short=[REDACTED]",
    );
  });
});
