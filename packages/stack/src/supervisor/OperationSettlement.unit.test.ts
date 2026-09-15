import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Predicate } from "effect";
import type { ActivationResult, BackendEndpoint } from "../gateway/Gateway.ts";
import { StackRuntimeError, type StackError } from "../public/Errors.ts";
import { beginStarting, dormant, ready } from "./CapabilityState.ts";
import { settleActivationOwner, settleLifecycleOwner } from "./OperationSettlement.ts";

const snapshotFor = (capability: ReturnType<typeof ready>) => ({
  stack: { _tag: "running" as const },
  sessionId: Symbol("session"),
  plan: undefined,
  capabilities: new Map([["rest" as const, capability]]),
});

describe("operation settlement", () => {
  it.effect("restores the saved root on a matching endpoint failure", () =>
    Effect.gen(function* () {
      const endpoint = yield* Deferred.make<Exit.Exit<BackendEndpoint, StackError>, never>();
      const current = ready(Symbol("session"), 3, true, { _tag: "resolving", deferred: endpoint });
      const result = Exit.fail(new StackRuntimeError({ message: "activation failed" }));
      const settlement = settleActivationOwner(snapshotFor(current), {
        _tag: "endpoint",
        capability: "rest",
        endpoint,
        priorRoot: false,
        result,
      });
      const next = settlement.snapshot.capabilities.get("rest");
      expect(Predicate.isTagged("ready")(next)).toBe(true);
      if (Predicate.isTagged("ready")(next)) {
        expect(next.root).toBe(false);
        expect(next.traffic).toBe(3);
        expect(next.endpoint).toEqual({ _tag: "unresolved" });
      }
      expect(settlement.reconcile).toBe("all-ready");
    }),
  );

  it.effect("publishes a stale completion without replacing the newer state", () =>
    Effect.gen(function* () {
      const endpoint = yield* Deferred.make<Exit.Exit<BackendEndpoint, StackError>, never>();
      const newer = ready(Symbol("newer"), 1, false);
      const snapshot = snapshotFor(newer);
      const result = Exit.succeed({ host: "127.0.0.1", port: 54321 });
      const settlement = settleActivationOwner(snapshot, {
        _tag: "endpoint",
        capability: "rest",
        endpoint,
        priorRoot: true,
        result,
      });
      expect(settlement.snapshot).toBe(snapshot);
      expect(settlement.snapshot.capabilities.get("rest")).toBe(newer);
      if (Predicate.isTagged("endpoint")(settlement.notification)) {
        expect(settlement.notification.completion).toBe(endpoint);
        expect(settlement.notification.result).toEqual(result);
      } else expect.fail("expected endpoint notification");
      expect(settlement.reconcile).toBe("all-ready");
    }),
  );

  it.effect("publishes a stale start recovery completion with its original result", () =>
    Effect.gen(function* () {
      const oldCompletion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const currentCompletion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const cause = Cause.fail(new StackRuntimeError({ message: "new operation failed" }));
      const snapshot = {
        ...snapshotFor(ready(Symbol("session"), 0, false)),
        stack: {
          _tag: "start-recovery" as const,
          attempt: Symbol("new-operation"),
          completion: currentCompletion,
          cause,
        },
      };
      const settlement = settleLifecycleOwner(snapshot, {
        _tag: "lifecycle",
        completion: oldCompletion,
        result: { _tag: "succeeded" },
      });
      expect(settlement.snapshot).toBe(snapshot);
      if (Predicate.isTagged("lifecycle")(settlement.notification)) {
        expect(settlement.notification.completion).toBe(oldCompletion);
        expect(settlement.notification.result).toEqual(Exit.void);
        expect(Exit.isSuccess(settlement.notification.result)).toBe(true);
      } else {
        expect.fail("expected lifecycle notification");
      }
    }),
  );

  it.effect("keeps the original failure for a matching start recovery", () =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const cause = Cause.fail(new StackRuntimeError({ message: "original failure" }));
      const snapshot = {
        ...snapshotFor(ready(Symbol("session"), 0, false)),
        stack: {
          _tag: "start-recovery" as const,
          attempt: Symbol("operation"),
          completion,
          cause,
        },
      };
      const settlement = settleLifecycleOwner(snapshot, {
        _tag: "lifecycle",
        completion,
        result: { _tag: "succeeded" },
      });
      expect(settlement.snapshot.stack).toEqual({ _tag: "stop-required", cause });
      if (Predicate.isTagged("lifecycle")(settlement.notification))
        expect(settlement.notification.result).toEqual(Exit.failCause(cause));
      else expect.fail("expected lifecycle notification");
    }),
  );

  it.effect("stops a queued activation that settles after the stack stopped", () =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<Exit.Exit<ActivationResult, StackError>, never>();
      const sessionId = Symbol("session");
      const current = beginStarting(dormant(sessionId), Symbol("operation"), {
        _tag: "activation",
        deferred: completion,
      });
      const snapshot = {
        stack: { _tag: "stopped" as const, session: "initialized" as const },
        sessionId,
        plan: undefined,
        capabilities: new Map([["rest" as const, current]]),
      };
      const result = Exit.fail(new StackRuntimeError({ message: "activation rejected" }));
      const settlement = settleActivationOwner(snapshot, {
        _tag: "activation",
        capability: "rest",
        completion,
        result,
      });

      expect(settlement.snapshot.capabilities.get("rest")).toEqual({ _tag: "stopped" });
      if (Predicate.isTagged("activation")(settlement.notification)) {
        expect(settlement.notification.completion).toBe(completion);
        expect(settlement.notification.result).toEqual(result);
      } else {
        expect.fail("expected activation notification");
      }
    }),
  );
});
