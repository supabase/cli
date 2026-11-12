import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import { make } from "../../src/command-internal/command-facts/command-output.ts";
import { Output } from "../../src/shared/output/output.service.ts";
import { mockOutput, OutputContractViolation } from "./mocks.ts";

const contract = make(Schema.Struct({ id: Schema.String, message: Schema.String }));

const run = <A, E>(
  format: "json" | "stream-json",
  handler: Effect.Effect<A, E, Output>,
): Effect.Effect<Exit.Exit<A, E>> => {
  const out = mockOutput({ format, contract });
  return Effect.exit(out.verifyCompletion(handler).pipe(Effect.provide(out.layer)));
};

const violation = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const error = Cause.squash(exit.cause);
  return Schema.is(OutputContractViolation)(error) ? error.reason : String(error);
};

const success = (data: Record<string, unknown>) =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.success("done", data);
  });

describe("mockOutput contract verification", () => {
  it.effect.each(["json", "stream-json"] as const)("accepts one valid result in %s", (format) =>
    Effect.gen(function* () {
      const exit = yield* run(format, success({ id: "a" }));
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("rejects a result that doesn't match the schema", () =>
    Effect.gen(function* () {
      const exit = yield* run("json", success({ id: 1 }));
      expect(violation(exit)).toBe("invalid-result");
    }),
  );

  it.effect("rejects a result with undeclared keys", () =>
    Effect.gen(function* () {
      const exit = yield* run("json", success({ id: "a", extra: true }));
      expect(violation(exit)).toBe("invalid-result");
    }),
  );

  it.effect("rejects a second result write", () =>
    Effect.gen(function* () {
      const exit = yield* run(
        "json",
        Effect.gen(function* () {
          const output = yield* Output;
          yield* output.success("done", { id: "a" });
          yield* output.result({ id: "b" });
        }),
      );
      expect(violation(exit)).toBe("duplicate-result");
    }),
  );

  it.effect("rejects a successful handler that writes no result", () =>
    Effect.gen(function* () {
      const exit = yield* run("json", Effect.void);
      expect(violation(exit)).toBe("missing-result");
    }),
  );

  it.effect("keeps a failing handler's own error", () =>
    Effect.gen(function* () {
      const exit = yield* run("json", Effect.fail("boom"));
      expect(violation(exit)).toBe("boom");
    }),
  );
});
