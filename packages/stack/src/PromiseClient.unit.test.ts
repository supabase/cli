import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { acquire } from "./PromiseClient.ts";
import { StackError } from "./Rpc.ts";

const failingFinalizers = Effect.addFinalizer(() => Effect.die(new Error("first finalizer"))).pipe(
  Effect.andThen(Effect.addFinalizer(() => Effect.die(new Error("second finalizer")))),
);
const messages = (error: unknown): ReadonlyArray<string> =>
  error instanceof AggregateError
    ? error.errors.flatMap(messages)
    : [error instanceof Error ? error.message : String(error)];

describe("Promise client cleanup", () => {
  it.effect("reports every finalizer failure when a client closes", () =>
    Effect.gen(function* () {
      const { client } = yield* Effect.promise(() => acquire(failingFinalizers));

      const failure = yield* Effect.promise(() =>
        client.close().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect([...messages(failure)].sort()).toEqual(["first finalizer", "second finalizer"]);
    }),
  );

  it.effect("keeps the acquisition failure and its cleanup failures together", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.promise(() =>
        acquire(
          failingFinalizers.pipe(
            Effect.andThen(
              Effect.fail(new StackError({ operation: "create", message: "refused" })),
            ),
          ),
        ).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure instanceof AggregateError ? failure.errors[0] : undefined).toBeInstanceOf(
        StackError,
      );
      expect([...messages(failure)].sort()).toEqual([
        "first finalizer",
        "refused",
        "second finalizer",
      ]);
    }),
  );
});
