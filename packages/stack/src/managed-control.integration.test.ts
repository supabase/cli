import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect } from "vitest";
import { acquireControl, controlEndpointPath } from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";

const STACK_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RUNTIME_ROOT = "/tmp/supabase-control-test";

const live = <A>(effect: Effect.Effect<A, any, any>) =>
  effect.pipe(Effect.provide(controlTransportLayer));

describe("managed control endpoint", () => {
  afterEach(() => undefined);

  it.live("derives one deterministic loopback endpoint from the ownership id", () => {
    return Effect.sync(() => {
      const path = controlEndpointPath(RUNTIME_ROOT, STACK_ID);
      expect(path).toBe("http://127.2.36.70:59273");
    });
  });

  it.live("attaches a concurrent caller to the live owner", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          const contender = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          expect(contender._tag).toBe("Attached");
          expect(yield* contender.ownerStatus).toMatchObject({
            protocolVersion: 1,
            state: "starting",
          });
          if (owner._tag === "Owned") yield* owner.close;
        }),
      ),
    ),
  );

  it.live("binds again after the owner scope releases the address", () =>
    live(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
            expect(owner._tag).toBe("Owned");
          }),
        );
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          }),
        );
        expect(next._tag).toBe("Owned");
      }),
    ),
  );

  it.live("rejects an unrelated listener without taking it over", () =>
    live(
      Effect.gen(function* () {
        const first = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
        const second = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
        expect(Exit.isSuccess(yield* second.ownerStatus.pipe(Effect.exit))).toBe(true);
        if (first._tag === "Owned") yield* first.close;
      }),
    ),
  );
});
