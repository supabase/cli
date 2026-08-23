import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { RuntimeGate } from "./RuntimeGate.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";

describe("RuntimeGate", () => {
  it("fails fast while the supervisor is starting", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* SupervisorLifecycle.make({
            ownershipId: "stack",
            ownerSessionId: "session",
            daemonCliVersion: "test",
            daemonBuildId: "build",
            close: Effect.void,
          });
          const gate = RuntimeGate.make(lifecycle);
          const exit = yield* Effect.exit(gate.stack);
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    );
  });
});
