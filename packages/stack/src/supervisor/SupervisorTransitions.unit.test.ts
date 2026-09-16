import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Predicate } from "effect";
import type { ActivationResult, BackendEndpoint } from "../gateway/Gateway.ts";
import { StackRuntimeError, type StackError } from "../public/Errors.ts";
import { isStackId } from "../public/StackId.ts";
import { beginStarting, beginStopping, dormant, ready } from "./CapabilityState.ts";
import {
  activationGate,
  admitActivation,
  admitLifecycle,
  endTraffic,
  settleActivationTerminal,
  settleLifecycleOwner,
  settleRetirementOwner,
  type ActivationExit,
  type EndpointExit,
} from "./SupervisorTransitions.ts";

const snapshotFor = (capability: ReturnType<typeof ready>) => ({
  stack: { _tag: "running" as const },
  sessionId: Symbol("session"),
  plan: undefined,
  capabilities: new Map([["rest" as const, capability]]),
});

describe("supervisor transitions", () => {
  it.effect("rejects activation during a stopped lifecycle", () =>
    Effect.gen(function* () {
      const value = "a".repeat(64);
      if (!isStackId(value)) return yield* Effect.die("invalid stack id fixture");
      const result = activationGate(
        {
          ...snapshotFor(ready(Symbol("session"), 0, false)),
          stack: { _tag: "stopped", session: "initialized" },
        },
        value,
      );
      expect(Predicate.isTagged(result, "rejected")).toBe(true);
      if (Predicate.isTagged(result, "rejected"))
        expect(result.error.message).toBe("Stack must be running before activation");
    }),
  );

  it.effect("uses the start-in-progress diagnostic during start recovery", () =>
    Effect.gen(function* () {
      const value = "a".repeat(64);
      if (!isStackId(value)) return yield* Effect.die("invalid stack id fixture");
      const cause = Cause.fail(new StackRuntimeError({ message: "cleanup pending" }));
      const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const result = activationGate(
        {
          ...snapshotFor(ready(Symbol("session"), 0, false)),
          stack: { _tag: "start-recovery", attempt: Symbol("start"), completion, cause },
        },
        value,
      );
      expect(Predicate.isTagged(result, "rejected")).toBe(true);
      if (Predicate.isTagged(result, "rejected"))
        expect(result.error.message).toBe("Cannot activate while start is in progress");
    }),
  );

  it.effect("rejects commands requiring recovery before admission", () =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const cause = Cause.fail(new StackRuntimeError({ message: "cleanup pending" }));
      const base = snapshotFor(ready(Symbol("session"), 0, false));
      const stop = admitLifecycle(
        { ...base, stack: { _tag: "stop-required", cause } },
        "start",
        completion,
        Symbol("start"),
      );
      const destroy = admitLifecycle(
        {
          ...base,
          stack: { _tag: "destroy-required", evidence: { _tag: "failed", cause } },
        },
        "start",
        completion,
        Symbol("start"),
      );
      const stopFromStopRequired = admitLifecycle(
        { ...base, stack: { _tag: "stop-required", cause } },
        "stop",
        completion,
        Symbol("stop"),
      );
      const stopFromDestroyRequired = admitLifecycle(
        {
          ...base,
          stack: { _tag: "destroy-required", evidence: { _tag: "failed", cause } },
        },
        "stop",
        completion,
        Symbol("stop"),
      );
      const destroyFromDestroyRequired = admitLifecycle(
        {
          ...base,
          stack: { _tag: "destroy-required", evidence: { _tag: "failed", cause } },
        },
        "destroy",
        completion,
        Symbol("destroy"),
      );
      expect(Predicate.isTagged(stop, "rejected") && stop.reason).toBe("stop-required");
      expect(Predicate.isTagged(destroy, "rejected") && destroy.reason).toBe("destroy-required");
      expect(Predicate.isTagged("accepted")(stopFromStopRequired)).toBe(true);
      if (Predicate.isTagged("accepted")(stopFromStopRequired)) {
        expect(stopFromStopRequired.snapshot.stack._tag).toBe("stopping");
        if (Predicate.isTagged("stopping")(stopFromStopRequired.snapshot.stack))
          expect(stopFromStopRequired.snapshot.stack.completion).toBe(completion);
      }
      expect(Predicate.isTagged("rejected")(stopFromDestroyRequired)).toBe(true);
      if (Predicate.isTagged("rejected")(stopFromDestroyRequired))
        expect(stopFromDestroyRequired.reason).toBe("destroy-required");
      expect(Predicate.isTagged("accepted")(destroyFromDestroyRequired)).toBe(true);
      if (Predicate.isTagged("accepted")(destroyFromDestroyRequired)) {
        expect(destroyFromDestroyRequired.snapshot.stack._tag).toBe("destroying");
        if (Predicate.isTagged("destroying")(destroyFromDestroyRequired.snapshot.stack))
          expect(destroyFromDestroyRequired.snapshot.stack.completion).toBe(completion);
      }
    }),
  );

  it.effect("claims endpoint resolution from one pure activation admission", () =>
    Effect.gen(function* () {
      const value = "a".repeat(64);
      if (!isStackId(value)) return yield* Effect.die("invalid stack id fixture");
      const endpoint = yield* Deferred.make<EndpointExit, never>();
      const activation = yield* Deferred.make<ActivationExit, never>();
      const decision = admitActivation(
        snapshotFor(ready(Symbol("session"), 0, false)),
        "rest",
        value,
        endpoint,
        activation,
        Symbol("activation"),
      );
      expect(Predicate.isTagged(decision, "endpoint-owner")).toBe(true);
      if (Predicate.isTagged(decision, "endpoint-owner")) {
        expect(decision.owner.endpoint).toBe(endpoint);
        const current = decision.snapshot.snapshot.capabilities.get("rest");
        expect(Predicate.isTagged(current, "ready")).toBe(true);
        if (Predicate.isTagged(current, "ready"))
          expect(current.endpoint).toEqual({ _tag: "resolving", deferred: endpoint });
      }
    }),
  );

  it.effect("restores the saved root on a matching endpoint failure", () =>
    Effect.gen(function* () {
      const endpoint = yield* Deferred.make<Exit.Exit<BackendEndpoint, StackError>, never>();
      const current = ready(Symbol("session"), 3, true, { _tag: "resolving", deferred: endpoint });
      const cause = Cause.fail(new StackRuntimeError({ message: "activation failed" }));
      const settlement = settleActivationTerminal(
        snapshotFor(current),
        {
          _tag: "endpoint",
          capability: "rest",
          endpoint,
          priorRoot: false,
        },
        { _tag: "none" },
        { _tag: "failed", cause, cleanup: { _tag: "proven" } },
      );
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
      const endpointResult = { host: "127.0.0.1", port: 54321 };
      const settlement = settleActivationTerminal(
        snapshot,
        {
          _tag: "endpoint",
          capability: "rest",
          endpoint,
          priorRoot: true,
        },
        { _tag: "none" },
        {
          _tag: "succeeded",
          value: { capability: "rest", endpoint: endpointResult },
        },
      );
      expect(settlement.snapshot).toBe(snapshot);
      expect(settlement.snapshot.capabilities.get("rest")).toBe(newer);
      const notification = settlement.notifications[0];
      if (notification !== undefined && Predicate.isTagged("endpoint")(notification)) {
        expect(notification.completion).toBe(endpoint);
        expect(notification.result).toEqual(Exit.succeed(endpointResult));
      } else expect.fail("expected endpoint notification");
      expect(settlement.reconcile).toBe("all-ready");
    }),
  );

  it.effect("ignores a stale unproven activation failure without claims", () =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<ActivationExit, never>();
      const newer = ready(Symbol("newer"), 1, false);
      const snapshot = snapshotFor(newer);
      const cause = Cause.fail(new StackRuntimeError({ message: "stale activation failed" }));
      const settlement = settleActivationTerminal(
        snapshot,
        { _tag: "activation", capability: "rest", completion },
        { _tag: "none" },
        { _tag: "failed", cause, cleanup: { _tag: "unproven", cause } },
      );

      expect(settlement.snapshot).toBe(snapshot);
      expect(settlement.snapshot.capabilities.get("rest")).toBe(newer);
      expect(settlement.snapshot.stack).toEqual({ _tag: "running" });
      const notification = settlement.notifications[0];
      if (notification !== undefined && Predicate.isTagged("activation")(notification)) {
        expect(notification.completion).toBe(completion);
        expect(notification.result).toEqual(Exit.failCause(cause));
      } else expect.fail("expected activation notification");
    }),
  );

  it.effect("does not restore claims into a newer session", () =>
    Effect.gen(function* () {
      const endpoint = yield* Deferred.make<EndpointExit, never>();
      const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const prior = dormant(Symbol("old-session"));
      const current = ready(Symbol("new-session"), 0, false);
      const snapshot = snapshotFor(current);
      const cause = Cause.fail(new StackRuntimeError({ message: "activation failed" }));
      const settlement = settleActivationTerminal(
        snapshot,
        { _tag: "endpoint", capability: "rest", endpoint, priorRoot: false },
        {
          _tag: "claimed",
          claimed: [{ name: "rest", completion, prior }],
          affected: new Set(["rest"]),
        },
        { _tag: "failed", cause, cleanup: { _tag: "proven" } },
      );
      expect(settlement.snapshot).toBe(snapshot);
      expect(settlement.snapshot.capabilities.get("rest")).toBe(current);
    }),
  );

  it.effect("preserves lifecycle start recovery after retirement failure", () =>
    Effect.gen(function* () {
      const lifecycleCompletion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const retirementCompletion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
      const operation = Symbol("retirement");
      const failure = new StackRuntimeError({ message: "retirement failed" });
      const cause = Cause.fail(failure);
      const capability = beginStopping(
        ready(Symbol("session"), 0, false),
        operation,
        retirementCompletion,
      );
      const snapshot = {
        ...snapshotFor(ready(Symbol("session"), 0, false)),
        stack: {
          _tag: "starting" as const,
          attempt: Symbol("start"),
          completion: lifecycleCompletion,
          prior: { _tag: "running" as const },
        },
        capabilities: new Map([["rest" as const, capability]]),
      };
      const settlement = settleRetirementOwner(snapshot, {
        _tag: "retirement",
        capability: "rest",
        operation,
        completion: retirementCompletion,
        result: Exit.fail(failure),
      });

      expect(settlement.snapshot.stack).toEqual({
        _tag: "start-recovery",
        attempt: snapshot.stack.attempt,
        completion: lifecycleCompletion,
        cause,
      });
    }),
  );

  it.effect("ignores traffic release from an older session", () =>
    Effect.sync(() => {
      const snapshot = snapshotFor(ready(Symbol("current"), 1, false));
      const transition = endTraffic(snapshot, "rest", Symbol("old"));

      expect(transition.snapshot).toBe(snapshot);
      expect(transition.shouldArm).toBe(false);
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
      const notification = settlement.notifications[0];
      if (notification !== undefined && Predicate.isTagged("lifecycle")(notification)) {
        expect(notification.completion).toBe(oldCompletion);
        expect(notification.result).toEqual(Exit.void);
        expect(Exit.isSuccess(notification.result)).toBe(true);
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
      const notification = settlement.notifications[0];
      if (notification !== undefined && Predicate.isTagged("lifecycle")(notification))
        expect(notification.result).toEqual(Exit.failCause(cause));
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
      const cause = Cause.fail(new StackRuntimeError({ message: "activation rejected" }));
      const settlement = settleActivationTerminal(
        snapshot,
        {
          _tag: "activation",
          capability: "rest",
          completion,
        },
        { _tag: "none" },
        { _tag: "failed", cause, cleanup: { _tag: "proven" } },
      );

      expect(settlement.snapshot.capabilities.get("rest")).toEqual({ _tag: "stopped" });
      const notification = settlement.notifications[0];
      if (notification !== undefined && Predicate.isTagged("activation")(notification)) {
        expect(notification.completion).toBe(completion);
        expect(notification.result).toEqual(Exit.failCause(cause));
      } else {
        expect.fail("expected activation notification");
      }
    }),
  );
});
