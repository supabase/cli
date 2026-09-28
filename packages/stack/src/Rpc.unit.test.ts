import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { OrchestratorError } from "./Orchestrator.ts";
import { StackError, stackError } from "./Rpc.ts";
import { ServiceError } from "./Service.ts";

const roundTrip = (error: StackError) =>
  Schema.encodeEffect(StackError)(error).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StackError)),
  );

describe("stackError", () => {
  it.effect("describes a wrapped error without a message by its cause", () =>
    Effect.gen(function* () {
      const cause = new Cause.UnknownError(new Error("container is gone"));
      const failure = stackError(
        "stop",
        new ServiceError({ operation: "stop", message: cause.message, cause }),
      );

      expect((yield* roundTrip(failure)).message).toBe("container is gone");
    }),
  );

  it.effect("names an error whose causes carry no message", () =>
    Effect.gen(function* () {
      const failure = stackError("stop", new Cause.UnknownError(undefined));

      expect((yield* roundTrip(failure)).message).toBe("UnknownError");
    }),
  );

  it.effect("keeps composition outcomes when the orchestrator error lacks a message", () =>
    Effect.gen(function* () {
      const cause = new Cause.UnknownError(42);
      const failure = stackError(
        "startComposition",
        new OrchestratorError({ operation: "start", message: cause.message, cause, outcomes: [] }),
      );

      const decoded = yield* roundTrip(failure);
      expect(decoded.message).toBe("42");
      expect(decoded.outcomes).toEqual([]);
    }),
  );
});
