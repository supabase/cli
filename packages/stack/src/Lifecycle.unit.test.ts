import { describe, expect, it } from "@effect/vitest";
import {
  canRunStorage,
  initialState,
  LifecycleEvent,
  makeGraph,
  reduce,
  type LifecycleCommand as Command,
  type LifecycleState,
  type ServiceSpec,
} from "./Lifecycle.ts";

const lazy = (id: string, overrides: Partial<ServiceSpec> = {}): ServiceSpec => ({
  id,
  activation: "lazy",
  prerequisites: [],
  idleMillis: 1_000,
  ...overrides,
});

const open = (id: string, waiterId: number, requireReady = true) =>
  LifecycleEvent.ConnectionOpened({ id, waiterId, requireReady });

/** Drives a sequence of events through one lifecycle state, returning each step's commands. */
const run = (
  initial: LifecycleState,
  steps: ReadonlyArray<{ event: LifecycleEvent; now: number }>,
) => {
  let state = initial;
  const commandsByStep: Array<ReadonlyArray<Command>> = [];
  for (const { event, now } of steps) {
    const [next, commands] = reduce(state, event, now);
    state = next;
    commandsByStep.push(commands);
  }
  return { state, commandsByStep };
};

const tagsOf = (commands: ReadonlyArray<Command> | undefined) =>
  (commands ?? []).map((command) => command._tag);

/** Narrows a service's current phase to `Starting` and returns its generation, or throws. */
const startingGeneration = (state: LifecycleState, id: string): number => {
  const phase = state.services.get(id)?.phase;
  if (phase?._tag !== "Starting") throw new Error(`Expected ${id} to be starting`);
  return phase.generation;
};

/** Reads a service's current generation from any non-`Stopped` phase, or throws. */
const currentGeneration = (state: LifecycleState, id: string): number => {
  const phase = state.services.get(id)?.phase;
  if (phase === undefined || phase._tag === "Stopped")
    throw new Error(`Expected ${id} to have a generation`);
  return phase.generation;
};

/** Indexed access with `noUncheckedIndexedAccess`; throws with a clear message if out of bounds. */
const at = <T>(array: ReadonlyArray<T>, index: number): T => {
  const value = array[index];
  if (value === undefined) throw new Error(`Expected an element at index ${index}`);
  return value;
};

/** Finds one command by tag, or throws; avoids a non-null assertion at call sites. */
const commandTagged = <Tag extends Command["_tag"]>(
  commands: ReadonlyArray<Command>,
  tag: Tag,
): Extract<Command, { _tag: Tag }> => {
  const found = commands.find(
    (command): command is Extract<Command, { _tag: Tag }> => command._tag === tag,
  );
  if (found === undefined) throw new Error(`Expected a ${tag} command`);
  return found;
};

describe("Lifecycle reducer", () => {
  it("wakes a lazy service on first traffic, admits the waiter once ready, and sleeps after idle", () => {
    const graph = makeGraph([lazy("api")]);
    const { commandsByStep, state } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 },
    ]);

    expect(tagsOf(commandsByStep[0])).toEqual(["ArmWaiterTimeout", "Launch"]);
    expect(tagsOf(commandsByStep[1])).toEqual(["AdmitConnection"]);
    expect(tagsOf(commandsByStep[2])).toEqual(["ArmIdleTimer"]);
    const armed = at(at(commandsByStep, 2), 0) as Extract<Command, { _tag: "ArmIdleTimer" }>;
    expect(armed).toMatchObject({ id: "api", generation: 1, epoch: 1, delayMillis: 1_000 });
    expect(state.services.get("api")?.phase).toEqual({
      _tag: "Running",
      generation: 1,
      ready: true,
    });
  });

  it("ignores a launch outcome, an idle elapse and an exit tagged with a stale generation", () => {
    const graph = makeGraph([lazy("api")]);
    const { state, commandsByStep } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 99 }), now: 10 },
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 99 }), now: 20 },
      {
        event: LifecycleEvent.Exited({
          id: "api",
          generation: 99,
          cause: "boom",
          requested: false,
        }),
        now: 30,
      },
    ]);

    expect(commandsByStep[1]).toEqual([]);
    expect(commandsByStep[2]).toEqual([]);
    expect(commandsByStep[3]).toEqual([]);
    expect(state.services.get("api")?.phase).toEqual({
      _tag: "Starting",
      generation: 1,
      stage: "preparing",
    });
  });

  it("ignores an idle elapse tagged with a stale epoch even while a newer timer is armed with zero demand", () => {
    const graph = makeGraph([lazy("api")]);
    const { state } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 }, // arms epoch 1
      { event: open("api", 2), now: 30 }, // demand returns: epoch 1's timer goes stale
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 40 }, // arms epoch 2
    ]);
    expect(state.services.get("api")?.idleArmedEpoch).toBe(2);

    const stale = run(state, [
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 1 }), now: 1_040 },
    ]);
    expect(stale.commandsByStep[0]).toEqual([]);
    expect(stale.state.services.get("api")?.phase._tag).toBe("Running");

    const current = run(stale.state, [
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 2 }), now: 1_041 },
    ]);
    expect(tagsOf(current.commandsByStep[0])).toEqual(["Stop"]);
  });

  it("keeps a service running when traffic is admitted before the idle commit", () => {
    const graph = makeGraph([lazy("api")]);
    const { state, commandsByStep } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 },
      // Traffic arrives while the timer is armed but before it fires: this prevents the sleep.
      { event: open("api", 2), now: 500 },
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 1 }), now: 1_000 },
    ]);

    expect(tagsOf(commandsByStep[3])).toEqual(["AdmitConnection"]);
    expect(commandsByStep[4]).toEqual([]);
    expect(state.services.get("api")?.phase._tag).toBe("Running");
    expect(state.services.get("api")?.leases).toBe(1);
  });

  it("holds traffic arriving after a committed sleep for the confirmed stop and the next generation, without failing it", () => {
    const graph = makeGraph([lazy("api")]);
    const { state, commandsByStep } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 },
      // The idle timer commits to stopping before any new traffic arrives.
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 1 }), now: 1_020 },
      { event: open("api", 2), now: 1_030 },
      {
        event: LifecycleEvent.Exited({
          id: "api",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 1_040,
      },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 2 }), now: 1_050 },
    ]);

    expect(tagsOf(commandsByStep[3])).toEqual(["Stop"]);
    expect(tagsOf(commandsByStep[4])).toEqual(["ArmWaiterTimeout"]);
    expect(tagsOf(commandsByStep[5])).toEqual(["Launch"]);
    expect((at(at(commandsByStep, 5), 0) as Extract<Command, { _tag: "Launch" }>).generation).toBe(
      2,
    );
    expect(tagsOf(commandsByStep[6])).toEqual(["AdmitConnection"]);
    expect(state.services.get("api")?.phase).toEqual({
      _tag: "Running",
      generation: 2,
      ready: true,
    });
  });

  it("keeps every prerequisite running while a dependent chain runs, and sleeps each one only once its own dependents confirm their stop", () => {
    const graph = makeGraph([
      lazy("database"),
      lazy("pg-meta", { prerequisites: ["database"] }),
      lazy("functions", { prerequisites: ["database"] }),
      lazy("studio", { prerequisites: ["pg-meta", "functions"] }),
    ]);
    let state = initialState(graph, 0);
    let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

    ({ state } = run(state, [{ event: open("studio", 1), now: 0 }]));
    expect(state.services.get("database")?.phase).toEqual({
      _tag: "Starting",
      generation: 1,
      stage: "preparing",
    });
    expect(state.services.get("pg-meta")?.phase._tag).toBe("Stopped");
    expect(state.services.get("functions")?.phase._tag).toBe("Stopped");

    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "database", generation: 1 }), now: 10 },
    ]));
    expect(state.services.get("pg-meta")?.phase._tag).toBe("Starting");
    expect(state.services.get("functions")?.phase._tag).toBe("Starting");

    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "pg-meta", generation: 1 }), now: 20 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "functions", generation: 1 }), now: 30 },
    ]));
    expect(state.services.get("studio")?.phase._tag).toBe("Starting");

    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "studio", generation: 1 }), now: 40 },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["AdmitConnection"]);

    // Studio idles and its exit is confirmed: only then do its prerequisites become idle-eligible.
    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.ConnectionClosed({ id: "studio" }), now: 50 },
      { event: LifecycleEvent.IdleElapsed({ id: "studio", generation: 1, epoch: 1 }), now: 1_050 },
    ]));
    expect(tagsOf(commandsByStep[1])).toEqual(["Stop"]);
    expect(state.services.get("pg-meta")?.idleArmedEpoch).toBeUndefined();
    expect(state.services.get("functions")?.idleArmedEpoch).toBeUndefined();
    // The database is a dependent-of-a-dependent: it still sees pg-meta/functions `Running`.
    expect(state.services.get("database")?.idleArmedEpoch).toBeUndefined();

    ({ state, commandsByStep } = run(state, [
      {
        event: LifecycleEvent.Exited({
          id: "studio",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 1_060,
      },
    ]));
    expect(state.services.get("studio")?.phase).toEqual({ _tag: "Stopped" });
    expect(tagsOf(commandsByStep[0]).sort()).toEqual(["ArmIdleTimer", "ArmIdleTimer"]);
    // pg-meta and functions are now merely idle-armed, still `Running`, so the database stays up.
    expect(state.services.get("database")?.phase._tag).toBe("Running");
    expect(state.services.get("database")?.idleArmedEpoch).toBeUndefined();

    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.IdleElapsed({ id: "pg-meta", generation: 1, epoch: 1 }), now: 2_060 },
      {
        event: LifecycleEvent.IdleElapsed({ id: "functions", generation: 1, epoch: 1 }),
        now: 2_060,
      },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["Stop"]);
    expect(tagsOf(commandsByStep[1])).toEqual(["Stop"]);

    ({ state } = run(state, [
      {
        event: LifecycleEvent.Exited({
          id: "pg-meta",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 2_070,
      },
    ]));
    // Functions is still running: the database still has a live dependent.
    expect(state.services.get("database")?.idleArmedEpoch).toBeUndefined();

    ({ state, commandsByStep } = run(state, [
      {
        event: LifecycleEvent.Exited({
          id: "functions",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 2_080,
      },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["ArmIdleTimer"]);
    expect(state.services.get("database")?.idleArmedEpoch).toBe(1);

    ({ state, commandsByStep } = run(state, [
      {
        event: LifecycleEvent.IdleElapsed({ id: "database", generation: 1, epoch: 1 }),
        now: 3_080,
      },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["Stop"]);

    ({ state } = run(state, [
      {
        event: LifecycleEvent.Exited({
          id: "database",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 3_090,
      },
    ]));
    expect(state.services.get("database")?.phase).toEqual({ _tag: "Stopped" });
  });

  it("blocks admission across the full prerequisite closure when a transitive prerequisite loses readiness", () => {
    const graph = makeGraph([
      lazy("a"),
      lazy("b", { prerequisites: ["a"] }),
      lazy("c", { prerequisites: ["b"] }),
    ]);
    let state = initialState(graph, 0);
    let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

    ({ state } = run(state, [{ event: open("c", 1), now: 0 }]));
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10 },
    ]));
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "b", generation: 1 }), now: 20 },
    ]));
    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "c", generation: 1 }), now: 30 },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["AdmitConnection"]);

    ({ state } = run(state, [
      {
        event: LifecycleEvent.ReadinessLost({ id: "a", generation: 1, cause: "db down" }),
        now: 40,
      },
    ]));
    // b and c are untouched directly: losing a prerequisite doesn't replace a healthy dependent.
    expect(state.services.get("b")?.phase).toEqual({ _tag: "Running", generation: 1, ready: true });
    expect(state.services.get("c")?.phase).toEqual({ _tag: "Running", generation: 1, ready: true });

    const blocked = run(state, [{ event: open("c", 2), now: 50 }]);
    expect(tagsOf(blocked.commandsByStep[0])).toEqual(["ArmWaiterTimeout"]);
    expect(blocked.state.services.get("c")?.waiters.size).toBe(1);

    const expired = run(blocked.state, [
      { event: LifecycleEvent.WaiterExpired({ id: "c", waiterId: 2 }), now: 50 + 120_000 + 1 },
    ]);
    const failure = commandTagged(at(expired.commandsByStep, 0), "FailConnection");
    expect(failure.message).toContain("prerequisite a");
  });

  describe("explicit start and restart demand", () => {
    it("launches an idle lazy service on its own explicit start, with no connection involved", () => {
      const graph = makeGraph([lazy("api")]);
      const { commandsByStep } = run(initialState(graph, 0), [
        { event: LifecycleEvent.StartRequested({ id: "api" }), now: 0 },
      ]);
      expect(tagsOf(commandsByStep[0])).toEqual(["Launch"]);
    });

    it("restarts after an explicit stop, even though restart alone would otherwise leave intent stopped", () => {
      const graph = makeGraph([lazy("api")]);
      let state = initialState(graph, 0);
      ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "api" }), now: 0 }]));

      const restarted = run(state, [
        { event: LifecycleEvent.RestartRequested({ id: "api" }), now: 1 },
      ]);
      expect(tagsOf(restarted.commandsByStep[0])).toEqual(["Launch"]);
      expect(restarted.state.services.get("api")?.intent).toBe("lazy");
    });

    it("propagates an explicit restart's demand to a fully stopped prerequisite", () => {
      const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      const { commandsByStep } = run(initialState(graph, 0), [
        { event: LifecycleEvent.RestartRequested({ id: "b" }), now: 0 },
      ]);
      expect(tagsOf(commandsByStep[0])).toEqual(["Launch"]);
      expect(commandTagged(at(commandsByStep, 0), "Launch").id).toBe("a");
    });
  });

  describe("circuit breaker", () => {
    it("opens after 3 consecutive failures, fails fast naming the cause, recovers once after the cooldown for several waiters at once, and resets after stable readiness", () => {
      const graph = makeGraph([lazy("flaky")]);
      let state = initialState(graph, 0);
      let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

      const failAttempt = (waiterId: number, now: number) => {
        ({ state, commandsByStep } = run(state, [{ event: open("flaky", waiterId), now }]));
        const generation = startingGeneration(state, "flaky");
        ({ state, commandsByStep } = run(state, [
          {
            event: LifecycleEvent.LaunchFailed({
              id: "flaky",
              generation,
              cause: `boom-${generation}`,
            }),
            now: now + 1,
          },
        ]));
        return commandsByStep;
      };

      failAttempt(1, 0);
      failAttempt(2, 100);
      const thirdFailure = failAttempt(3, 200);
      expect(at(thirdFailure, 0).some((command) => command._tag === "FailConnection")).toBe(true);
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(3);
      expect(state.services.get("flaky")?.breaker.openUntil).toBe(201 + 30_000);

      // Fails fast while the breaker is open, naming the last cause, without a new launch.
      ({ state, commandsByStep } = run(state, [{ event: open("flaky", 4), now: 300 }]));
      expect(tagsOf(commandsByStep[0])).toEqual(["FailConnection"]);
      const fastFail = commandTagged(at(commandsByStep, 0), "FailConnection");
      expect(fastFail.cause).toBe("boom-3");
      expect(state.services.get("flaky")?.phase._tag).toBe("Failed");

      // The dedicated cooldown event is what reopens admission, not the mere passage of time.
      ({ state } = run(state, [
        {
          event: LifecycleEvent.CooldownElapsed({ id: "flaky", openUntil: 201 + 30_000 }),
          now: 201 + 30_000,
        },
      ]));

      // After the cooldown elapses, several waiters share exactly one recovery attempt.
      ({ state, commandsByStep } = run(state, [{ event: open("flaky", 5), now: 201 + 30_000 }]));
      expect(tagsOf(commandsByStep[0])).toEqual(["ArmWaiterTimeout", "Launch"]);
      const recovery = commandTagged(at(commandsByStep, 0), "Launch");

      ({ state, commandsByStep } = run(state, [
        { event: open("flaky", 6), now: 201 + 30_000 + 1 },
      ]));
      expect(tagsOf(commandsByStep[0])).toEqual(["ArmWaiterTimeout"]);

      ({ state, commandsByStep } = run(state, [
        {
          event: LifecycleEvent.LaunchSucceeded({ id: "flaky", generation: recovery.generation }),
          now: 201 + 30_000 + 10,
        },
      ]));
      expect(tagsOf(commandsByStep[0]).toSorted()).toEqual(["AdmitConnection", "AdmitConnection"]);

      // 30s of stable readiness on the same generation resets the breaker lazily, at the next event.
      ({ state, commandsByStep } = run(state, [
        {
          event: LifecycleEvent.Exited({
            id: "flaky",
            generation: recovery.generation,
            cause: "crash",
            requested: false,
          }),
          now: 201 + 30_000 + 10 + 30_000 + 1,
        },
      ]));
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(1);
      expect(state.services.get("flaky")?.breaker.openUntil).toBeUndefined();
    });

    it("doubles the cooldown on a second breaker open and an explicit start resets it", () => {
      const graph = makeGraph([lazy("flaky")]);
      let state = initialState(graph, 0);

      const fail = (waiterId: number, now: number) => {
        ({ state } = run(state, [{ event: open("flaky", waiterId), now }]));
        const generation = startingGeneration(state, "flaky");
        ({ state } = run(state, [
          {
            event: LifecycleEvent.LaunchFailed({ id: "flaky", generation, cause: "boom" }),
            now: now + 1,
          },
        ]));
      };

      fail(1, 0);
      fail(2, 1);
      fail(3, 2);
      expect(state.services.get("flaky")?.breaker.openUntil).toBe(3 + 30_000);

      ({ state } = run(state, [
        {
          event: LifecycleEvent.CooldownElapsed({ id: "flaky", openUntil: 3 + 30_000 }),
          now: 3 + 30_000,
        },
      ]));
      fail(4, 3 + 30_000);
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(4);
      expect(state.services.get("flaky")?.breaker.openUntil).toBe(3 + 30_000 + 1 + 60_000);

      ({ state } = run(
        state,
        [{ event: LifecycleEvent.StartRequested({ id: "flaky" }) }].map((step) => ({
          ...step,
          now: 500_000,
        })),
      ));
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(0);
      expect(state.services.get("flaky")?.breaker.openUntil).toBeUndefined();
    });

    it("schedules a cooldown timer when the breaker opens and only the dedicated event retries, even with demand retained the whole time", () => {
      const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      let state = initialState(graph, 0);
      let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

      // b's own waiter on a never resolves, so it keeps retaining demand on a across every retry.
      ({ state, commandsByStep } = run(state, [{ event: open("b", 1), now: 0 }]));
      expect(tagsOf(commandsByStep[0])).toEqual(["ArmWaiterTimeout", "Launch"]);

      const failRetained = (now: number) => {
        const generation = startingGeneration(state, "a");
        ({ state, commandsByStep } = run(state, [
          { event: LifecycleEvent.LaunchFailed({ id: "a", generation, cause: "boom" }), now },
        ]));
        return commandsByStep;
      };

      // The first two failures retry on their own, because b's waiter still holds demand on a.
      failRetained(1);
      expect(state.services.get("a")?.phase._tag).toBe("Starting");
      failRetained(2);
      const third = failRetained(3);
      expect(state.services.get("a")?.phase._tag).toBe("Failed");
      const armed = commandTagged(at(third, 0), "ArmCooldownTimer");

      // Demand is still retained, but the breaker stays shut until the dedicated event fires.
      const stillClosed = run(state, [
        { event: LifecycleEvent.ConnectionClosed({ id: "a" }), now: armed.openUntil - 1 },
      ]);
      expect(stillClosed.state.services.get("a")?.phase._tag).toBe("Failed");

      const elapsed = run(state, [
        {
          event: LifecycleEvent.CooldownElapsed({ id: "a", openUntil: armed.openUntil }),
          now: armed.openUntil,
        },
      ]);
      expect(tagsOf(elapsed.commandsByStep[0])).toEqual(["Launch"]);
    });

    it("leaves a stale launch outcome a complete no-op even with demand retained and the cooldown elapsed on the wall clock", () => {
      const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      let state = initialState(graph, 0);

      // b's own waiter on a is never resolved, so demand on a is retained through every failure:
      // under the old time-based breaker check, this is exactly the state a stale event could
      // have exploited to sneak a new launch past the still-open breaker.
      ({ state } = run(state, [{ event: open("b", 1), now: 0 }]));

      const fail = (now: number) => {
        const generation = startingGeneration(state, "a");
        ({ state } = run(state, [
          { event: LifecycleEvent.LaunchFailed({ id: "a", generation, cause: "boom" }), now },
        ]));
      };
      fail(1);
      fail(2);
      fail(3);
      expect(state.services.get("a")?.breaker.openUntil).toBeDefined();
      expect(state.services.get("a")?.phase._tag).toBe("Failed");

      // Far past the cooldown on the wall clock, but no `CooldownElapsed` has been processed yet.
      const stale = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10_000_000 },
      ]);
      expect(stale.commandsByStep[0]).toEqual([]);
      expect(stale.state).toEqual(state);
    });

    it("materializes an already-earned stability reset before a readiness loss discards the evidence", () => {
      const graph = makeGraph([lazy("flaky")]);
      let state = initialState(graph, 0);

      const fail = (waiterId: number, now: number) => {
        ({ state } = run(state, [{ event: open("flaky", waiterId), now }]));
        const generation = startingGeneration(state, "flaky");
        ({ state } = run(state, [
          {
            event: LifecycleEvent.LaunchFailed({ id: "flaky", generation, cause: "boom" }),
            now: now + 1,
          },
        ]));
      };
      fail(1, 0);
      fail(2, 100);

      ({ state } = run(state, [{ event: open("flaky", 3), now: 200 }]));
      const generation = startingGeneration(state, "flaky");
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "flaky", generation }), now: 201 },
      ]));

      ({ state } = run(state, [
        {
          event: LifecycleEvent.ReadinessLost({ id: "flaky", generation, cause: "blip" }),
          now: 201 + 30_000 + 1,
        },
      ]));
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(0);

      const result = run(state, [
        {
          event: LifecycleEvent.Exited({
            id: "flaky",
            generation,
            cause: "crash",
            requested: false,
          }),
          now: 201 + 30_000 + 2,
        },
      ]);
      expect(result.state.services.get("flaky")?.breaker.consecutiveFailures).toBe(1);
      expect(result.state.services.get("flaky")?.breaker.openUntil).toBeUndefined();
    });

    it("materializes an already-earned stability reset before an idle stop starts a new generation", () => {
      const graph = makeGraph([lazy("flaky")]);
      let state = initialState(graph, 0);

      const fail = (waiterId: number, now: number) => {
        ({ state } = run(state, [{ event: open("flaky", waiterId), now }]));
        const generation = startingGeneration(state, "flaky");
        ({ state } = run(state, [
          {
            event: LifecycleEvent.LaunchFailed({ id: "flaky", generation, cause: "boom" }),
            now: now + 1,
          },
        ]));
      };
      fail(1, 0);
      fail(2, 100);

      ({ state } = run(state, [{ event: open("flaky", 3), now: 200 }]));
      const generation = startingGeneration(state, "flaky");
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "flaky", generation }), now: 201 },
        { event: LifecycleEvent.ConnectionClosed({ id: "flaky" }), now: 202 },
      ]));

      ({ state } = run(state, [
        {
          event: LifecycleEvent.IdleElapsed({ id: "flaky", generation, epoch: 1 }),
          now: 202 + 30_000 + 1_000,
        },
      ]));
      expect(state.services.get("flaky")?.breaker.consecutiveFailures).toBe(0);

      ({ state } = run(state, [
        {
          event: LifecycleEvent.Exited({
            id: "flaky",
            generation,
            cause: undefined,
            requested: true,
          }),
          now: 202 + 30_000 + 1_000 + 10,
        },
      ]));
      expect(state.services.get("flaky")?.phase).toEqual({ _tag: "Stopped" });

      const nextAttempt = run(state, [{ event: open("flaky", 4), now: 1_000_000 }]);
      const nextGeneration = startingGeneration(nextAttempt.state, "flaky");
      const result = run(nextAttempt.state, [
        {
          event: LifecycleEvent.LaunchFailed({
            id: "flaky",
            generation: nextGeneration,
            cause: "boom",
          }),
          now: 1_000_001,
        },
      ]);
      expect(result.state.services.get("flaky")?.breaker.consecutiveFailures).toBe(1);
    });
  });

  it("caps waiters at 256, lets an expiry fail only that waiter while the shared launch continues, and frees its slot for cancellation", () => {
    const graph = makeGraph([lazy("api")]);
    let state = initialState(graph, 0);
    let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

    const opens = Array.from({ length: 256 }, (_, index) => ({
      event: open("api", index + 1),
      now: 0,
    }));
    ({ state } = run(state, opens));
    expect(state.services.get("api")?.waiters.size).toBe(256);
    expect(state.services.get("api")?.phase._tag).toBe("Starting");

    ({ state, commandsByStep } = run(state, [{ event: open("api", 257), now: 1 }]));
    expect(tagsOf(commandsByStep[0])).toEqual(["FailConnection"]);
    expect(state.services.get("api")?.waiters.size).toBe(256);

    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.WaiterExpired({ id: "api", waiterId: 5 }), now: 120_001 },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["FailConnection"]);
    const expired = commandTagged(at(commandsByStep, 0), "FailConnection");
    expect(expired.message).toContain("api to finish preparing");
    expect(state.services.get("api")?.waiters.size).toBe(255);
    // The shared launch itself is untouched by a waiter's own expiry.
    expect(state.services.get("api")?.phase._tag).toBe("Starting");

    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.WaiterCancelled({ id: "api", waiterId: 6 }), now: 2 },
    ]));
    expect(commandsByStep[0]).toEqual([]);
    expect(state.services.get("api")?.waiters.size).toBe(254);

    ({ state, commandsByStep } = run(state, [{ event: open("api", 300), now: 3 }]));
    expect(tagsOf(commandsByStep[0])).toEqual(["ArmWaiterTimeout"]);
    expect(state.services.get("api")?.waiters.size).toBe(255);
  });

  it("expires a waiter instead of admitting it when its deadline already passed by the time the launch succeeds", () => {
    const graph = makeGraph([lazy("api", { waiterBudgetMillis: 100, idleMillis: undefined })]);
    let state = initialState(graph, 0);
    ({ state } = run(state, [{ event: open("api", 1), now: 0 }]));
    const generation = startingGeneration(state, "api");

    const result = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation }), now: 500 },
    ]);
    expect(tagsOf(result.commandsByStep[0])).toEqual(["FailConnection"]);
    expect(result.state.services.get("api")?.leases).toBe(0);
  });

  it("admits a non-ready-requiring acquisition once a live session exists, bypassing target readiness", () => {
    const graph = makeGraph([lazy("functions")]);
    let state = initialState(graph, 0);
    ({ state } = run(state, [{ event: open("functions", 1), now: 0 }]));
    const generation = startingGeneration(state, "functions");

    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "functions", generation }), now: 10 },
      {
        event: LifecycleEvent.ReadinessLost({
          id: "functions",
          generation,
          cause: "still booting",
        }),
        now: 11,
      },
    ]));
    expect(state.services.get("functions")?.phase).toEqual({
      _tag: "Running",
      generation,
      ready: false,
    });

    const readyRequiring = run(state, [{ event: open("functions", 2), now: 20 }]);
    expect(tagsOf(readyRequiring.commandsByStep[0])).toEqual(["ArmWaiterTimeout"]);

    const inspector = run(state, [
      {
        event: LifecycleEvent.ConnectionOpened({
          id: "functions",
          waiterId: 3,
          requireReady: false,
        }),
        now: 20,
      },
    ]);
    expect(tagsOf(inspector.commandsByStep[0])).toEqual(["AdmitConnection"]);
  });

  it("treats a readiness loss as non-terminal with a reprobe, unlike an exit which counts toward the breaker", () => {
    const graph = makeGraph([lazy("api")]);
    const { state: ready } = run(initialState(graph, 0), [
      { event: open("api", 1), now: 0 },
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
    ]);

    const { state: afterReadinessLoss, commandsByStep: lostCommands } = run(ready, [
      {
        event: LifecycleEvent.ReadinessLost({ id: "api", generation: 1, cause: "probe failed" }),
        now: 20,
      },
    ]);
    expect(tagsOf(lostCommands[0])).toEqual(["Reprobe"]);
    expect(afterReadinessLoss.services.get("api")?.phase).toEqual({
      _tag: "Running",
      generation: 1,
      ready: false,
    });
    expect(afterReadinessLoss.services.get("api")?.breaker.consecutiveFailures).toBe(0);

    const { state: recovered } = run(afterReadinessLoss, [
      { event: LifecycleEvent.ReadinessRecovered({ id: "api", generation: 1 }), now: 30 },
    ]);
    expect(recovered.services.get("api")?.phase).toEqual({
      _tag: "Running",
      generation: 1,
      ready: true,
    });
    expect(recovered.services.get("api")?.breaker.consecutiveFailures).toBe(0);

    // Closing the lease first removes all demand, so the crash below settles into `Failed`
    // instead of an immediate crash re-wake, isolating the phase/breaker assertion that follows.
    const { state: idle } = run(ready, [
      { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 15 },
    ]);
    const { state: afterExit, commandsByStep: exitCommands } = run(idle, [
      {
        event: LifecycleEvent.Exited({
          id: "api",
          generation: 1,
          cause: "crash",
          requested: false,
        }),
        now: 20,
      },
    ]);
    expect(afterExit.services.get("api")?.phase).toMatchObject({ _tag: "Failed", cause: "crash" });
    expect(afterExit.services.get("api")?.breaker.consecutiveFailures).toBe(1);
    expect(exitCommands[0]).toEqual([]);
  });

  it("rejects stopping or restarting a prerequisite while a dependent is active", () => {
    const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
    let state = initialState(graph, 0);
    ({ state } = run(state, [{ event: open("b", 1), now: 0 }]));
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10 },
    ]));
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "b", generation: 1 }), now: 20 },
    ]));
    expect(state.services.get("b")?.leases).toBe(1);

    const stopResult = run(state, [{ event: LifecycleEvent.StopRequested({ id: "a" }), now: 30 }]);
    expect(tagsOf(stopResult.commandsByStep[0])).toEqual(["RequestRejected"]);
    expect(stopResult.state.services.get("a")?.phase._tag).toBe("Running");

    const restartResult = run(state, [
      { event: LifecycleEvent.RestartRequested({ id: "a" }), now: 30 },
    ]);
    expect(tagsOf(restartResult.commandsByStep[0])).toEqual(["RequestRejected"]);
    expect(restartResult.state.services.get("a")?.phase).toEqual({
      _tag: "Running",
      generation: 1,
      ready: true,
    });
  });

  describe("storage reservation", () => {
    it("admits storage operations only once a service is stopped with intent stopped", () => {
      const graph = makeGraph([lazy("database")]);
      let state = initialState(graph, 0);
      expect(canRunStorage(state, "database")).toBe(false);

      ({ state } = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "database" }), now: 0 },
      ]));
      expect(canRunStorage(state, "database")).toBe(true);

      ({ state } = run(state, [
        { event: LifecycleEvent.StartRequested({ id: "database" }), now: 1 },
      ]));
      ({ state } = run(state, [{ event: open("database", 1), now: 2 }]));
      expect(canRunStorage(state, "database")).toBe(false);
    });

    it("rejects a storage reservation unless the service is already stopped", () => {
      const graph = makeGraph([lazy("database")]);
      const { commandsByStep } = run(initialState(graph, 0), [
        { event: LifecycleEvent.StorageReserved({ id: "database" }), now: 0 },
      ]);
      expect(tagsOf(commandsByStep[0])).toEqual(["RequestRejected"]);
    });

    it("blocks a launch while storage is reserved and relaunches once it's released", () => {
      const graph = makeGraph([lazy("database")]);
      let state = initialState(graph, 0);
      ({ state } = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "database" }), now: 0 },
      ]));

      const reserved = run(state, [
        { event: LifecycleEvent.StorageReserved({ id: "database" }), now: 1 },
      ]);
      expect(reserved.commandsByStep[0]).toEqual([]);
      expect(reserved.state.services.get("database")?.storageReserved).toBe(true);
      state = reserved.state;

      // An explicit start during the restore can't emit a launch while storage is reserved.
      const duringRestore = run(state, [
        { event: LifecycleEvent.StartRequested({ id: "database" }), now: 2 },
      ]);
      expect(duringRestore.commandsByStep[0]).toEqual([]);
      state = duringRestore.state;

      const released = run(state, [
        { event: LifecycleEvent.StorageReleased({ id: "database" }), now: 3 },
      ]);
      expect(tagsOf(released.commandsByStep[0])).toEqual(["Launch"]);
    });
  });

  it("rejects new admission for an explicitly stopped service without creating a waiter", () => {
    const graph = makeGraph([lazy("api")]);
    let state = initialState(graph, 0);
    ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "api" }), now: 0 }]));

    const result = run(state, [{ event: open("api", 1), now: 1 }]);
    expect(tagsOf(result.commandsByStep[0])).toEqual(["FailConnection"]);
    expect(result.state.services.get("api")?.waiters.size).toBe(0);
  });

  it("starts an eager service's prerequisite on its own and cascades once that prerequisite is ready", () => {
    const graph = makeGraph([
      lazy("database", { idleMillis: undefined }),
      { id: "kong", activation: "eager", prerequisites: ["database"] },
    ]);
    let state = initialState(graph, 0);
    let commandsByStep: ReadonlyArray<ReadonlyArray<Command>>;

    // Kong is eager from composition, so the owner's first settle pass (triggered by any event,
    // here the composition's own start signal) already starts its prerequisite without a waiter.
    ({ state } = run(state, [{ event: LifecycleEvent.StartRequested({ id: "kong" }), now: 0 }]));
    expect(state.services.get("database")?.phase._tag).toBe("Starting");
    expect(state.services.get("kong")?.phase._tag).toBe("Stopped");

    ({ state, commandsByStep } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "database", generation: 1 }), now: 10 },
    ]));
    expect(tagsOf(commandsByStep[0])).toEqual(["Launch"]);
    expect(state.services.get("kong")?.phase._tag).toBe("Starting");
  });

  describe("graph updates", () => {
    it("preserves a continuing service's state and never reuses a generation after a remove and re-add", () => {
      let state = initialState(makeGraph([lazy("api")]), 0);
      ({ state } = run(state, [{ event: open("api", 1), now: 0 }]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
      ]));
      ({ state } = run(state, [
        { event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 },
      ]));
      ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "api" }), now: 30 }]));
      ({ state } = run(state, [
        {
          event: LifecycleEvent.Exited({
            id: "api",
            generation: 1,
            cause: undefined,
            requested: true,
          }),
          now: 31,
        },
      ]));
      expect(state.services.get("api")?.phase).toEqual({ _tag: "Stopped" });

      ({ state } = run(state, [
        { event: LifecycleEvent.GraphUpdated({ graph: makeGraph([]) }), now: 40 },
      ]));
      expect(state.services.has("api")).toBe(false);

      ({ state } = run(state, [
        { event: LifecycleEvent.GraphUpdated({ graph: makeGraph([lazy("api")]) }), now: 50 },
      ]));
      expect(state.services.get("api")?.phase).toEqual({ _tag: "Stopped" });

      const relaunch = run(state, [
        { event: LifecycleEvent.StartRequested({ id: "api" }), now: 60 },
      ]);
      expect(commandTagged(at(relaunch.commandsByStep, 0), "Launch").generation).toBe(2);
    });

    it("rejects removing a service that's starting with a pending waiter, atomically", () => {
      let state = initialState(makeGraph([lazy("a")]), 0);
      ({ state } = run(state, [{ event: open("a", 1), now: 0 }]));
      expect(state.services.get("a")?.phase._tag).toBe("Starting");

      const rejected = run(state, [
        { event: LifecycleEvent.GraphUpdated({ graph: makeGraph([]) }), now: 10 },
      ]);
      expect(tagsOf(rejected.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(rejected.state).toEqual(state);
    });

    it("rejects removing a service with a storage reservation, so a graph update can't launch mid-restore", () => {
      let state = initialState(makeGraph([lazy("db")]), 0);
      ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "db" }), now: 0 }]));
      ({ state } = run(state, [{ event: LifecycleEvent.StorageReserved({ id: "db" }), now: 1 }]));
      expect(state.services.get("db")?.storageReserved).toBe(true);

      const rejected = run(state, [
        { event: LifecycleEvent.GraphUpdated({ graph: makeGraph([]) }), now: 2 },
      ]);
      expect(tagsOf(rejected.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(rejected.state).toEqual(state);
    });

    it("rejects changing an active continuing service's prerequisites, leaving its live generation untouched", () => {
      const graphV1 = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      let state = initialState(graphV1, 0);
      ({ state } = run(state, [{ event: open("b", 1), now: 0 }]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10 },
      ]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "b", generation: 1 }), now: 20 },
      ]));
      expect(state.services.get("b")?.leases).toBe(1);

      // b keeps its id but drops a from its prerequisites, while b is still actively running on a.
      const graphV2 = makeGraph([lazy("a"), lazy("b", { prerequisites: [] })]);
      const rejected = run(state, [
        { event: LifecycleEvent.GraphUpdated({ graph: graphV2 }), now: 30 },
      ]);
      expect(tagsOf(rejected.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(rejected.state).toEqual(state);

      // The update never took effect: a is still b's prerequisite and still can't be stopped.
      const stopResult = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "a" }), now: 40 },
      ]);
      expect(tagsOf(stopResult.commandsByStep[0])).toEqual(["RequestRejected"]);
    });
  });

  describe("stage reporting", () => {
    it("updates the starting stage so a waiter's budget error names it", () => {
      let state = initialState(makeGraph([lazy("api", { waiterBudgetMillis: 50 })]), 0);
      ({ state } = run(state, [{ event: open("api", 1), now: 0 }]));
      const generation = startingGeneration(state, "api");

      ({ state } = run(state, [
        {
          event: LifecycleEvent.StageChanged({ id: "api", generation, stage: "artifacts" }),
          now: 1,
        },
      ]));
      expect(state.services.get("api")?.phase).toEqual({
        _tag: "Starting",
        generation,
        stage: "artifacts",
      });

      const expired = run(state, [
        { event: LifecycleEvent.WaiterExpired({ id: "api", waiterId: 1 }), now: 100 },
      ]);
      const failure = commandTagged(at(expired.commandsByStep, 0), "FailConnection");
      expect(failure.message).toContain("api to finish artifacts");
    });

    it("ignores a stage change tagged with a stale generation", () => {
      let state = initialState(makeGraph([lazy("api")]), 0);
      ({ state } = run(state, [{ event: open("api", 1), now: 0 }]));
      const result = run(state, [
        {
          event: LifecycleEvent.StageChanged({ id: "api", generation: 99, stage: "artifacts" }),
          now: 1,
        },
      ]);
      expect(result.state).toEqual(state);
    });
  });

  describe("the dependent guard", () => {
    it("protects stranded downstream demand even when the immediate dependent is itself inactive", () => {
      const graph = makeGraph([
        lazy("a"),
        lazy("b", { prerequisites: ["a"] }),
        lazy("c", { prerequisites: ["b"] }),
      ]);
      let state = initialState(graph, 0);
      ({ state } = run(state, [{ event: open("c", 1), now: 0 }]));
      expect(state.services.get("a")?.phase._tag).toBe("Starting");
      expect(state.services.get("b")?.phase._tag).toBe("Stopped");
      expect(state.services.get("c")?.waiters.size).toBe(1);

      const stopResult = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "a" }), now: 10 },
      ]);
      expect(tagsOf(stopResult.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(stopResult.state).toEqual(state);
    });

    it("still protects a dependent's demand once the prerequisite's own breaker has opened", () => {
      const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      let state = initialState(graph, 0);
      ({ state } = run(state, [{ event: open("b", 1), now: 0 }]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10 },
      ]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "b", generation: 1 }), now: 20 },
      ]));
      expect(state.services.get("b")?.leases).toBe(1);

      // b's lease retains demand on a, so each crash immediately relaunches the next generation,
      // until the third failure opens the breaker and a finally rests in `Failed`.
      const crash = (now: number) => {
        const generation = currentGeneration(state, "a");
        ({ state } = run(state, [
          {
            event: LifecycleEvent.Exited({ id: "a", generation, cause: "crash", requested: false }),
            now,
          },
        ]));
      };
      crash(30);
      crash(31);
      crash(32);
      expect(state.services.get("a")?.breaker.openUntil).toBeDefined();
      expect(state.services.get("a")?.phase._tag).toBe("Failed");

      const stopResult = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "a" }), now: 40 },
      ]);
      expect(tagsOf(stopResult.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(stopResult.state.services.get("a")?.phase._tag).toBe("Failed");

      const restartResult = run(state, [
        { event: LifecycleEvent.RestartRequested({ id: "a" }), now: 40 },
      ]);
      expect(tagsOf(restartResult.commandsByStep[0])).toEqual(["RequestRejected"]);
    });

    it("blocks an explicit stop or restart of a prerequisite while a sleeping dependent is still wake-armed", () => {
      const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
      let state = initialState(graph, 0);
      ({ state } = run(state, [{ event: open("b", 1), now: 0 }]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "a", generation: 1 }), now: 10 },
      ]));
      ({ state } = run(state, [
        { event: LifecycleEvent.LaunchSucceeded({ id: "b", generation: 1 }), now: 20 },
      ]));
      ({ state } = run(state, [{ event: LifecycleEvent.ConnectionClosed({ id: "b" }), now: 30 }]));
      expect(state.services.get("b")?.idleArmedEpoch).toBe(1);

      ({ state } = run(state, [
        { event: LifecycleEvent.IdleElapsed({ id: "b", generation: 1, epoch: 1 }), now: 1_030 },
      ]));
      ({ state } = run(state, [
        {
          event: LifecycleEvent.Exited({
            id: "b",
            generation: 1,
            cause: undefined,
            requested: true,
          }),
          now: 1_040,
        },
      ]));
      expect(state.services.get("b")?.phase).toEqual({ _tag: "Stopped" });
      expect(state.services.get("b")?.intent).toBe("lazy");

      // b is asleep, not explicitly stopped, so it can still wake on its own: a can't be torn down.
      const stopResult = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "a" }), now: 1_050 },
      ]);
      expect(tagsOf(stopResult.commandsByStep[0])).toEqual(["RequestRejected"]);
      expect(stopResult.state.services.get("a")?.phase._tag).toBe("Running");

      const restartResult = run(state, [
        { event: LifecycleEvent.RestartRequested({ id: "a" }), now: 1_050 },
      ]);
      expect(tagsOf(restartResult.commandsByStep[0])).toEqual(["RequestRejected"]);

      // Once b is explicitly stopped too, a's stop is no longer blocked.
      ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "b" }), now: 1_060 }]));
      const stopAfter = run(state, [
        { event: LifecycleEvent.StopRequested({ id: "a" }), now: 1_070 },
      ]);
      expect(tagsOf(stopAfter.commandsByStep[0])).not.toContain("RequestRejected");
    });
  });

  it("re-arms a stopped prerequisite when its dependent is explicitly restarted", () => {
    const graph = makeGraph([lazy("a"), lazy("b", { prerequisites: ["a"] })]);
    let state = initialState(graph, 0);
    ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "b" }), now: 0 }]));
    ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "a" }), now: 1 }]));
    expect(state.services.get("a")?.intent).toBe("stopped");

    const restarted = run(state, [{ event: LifecycleEvent.RestartRequested({ id: "b" }), now: 2 }]);
    expect(restarted.state.services.get("a")?.intent).toBe("lazy");
    expect(tagsOf(restarted.commandsByStep[0])).toEqual(["Launch"]);
    expect(commandTagged(at(restarted.commandsByStep, 0), "Launch").id).toBe("a");
  });

  it("keeps an explicit start's demand through a committed stop so the next generation launches once the exit is confirmed", () => {
    let state = initialState(makeGraph([lazy("api")]), 0);
    ({ state } = run(state, [{ event: LifecycleEvent.StartRequested({ id: "api" }), now: 0 }]));
    expect(state.services.get("api")?.phase._tag).toBe("Starting");
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
    ]));
    expect(state.services.get("api")?.leases).toBe(0);

    ({ state } = run(state, [{ event: LifecycleEvent.StopRequested({ id: "api" }), now: 20 }]));
    expect(state.services.get("api")?.phase._tag).toBe("Stopping");

    ({ state } = run(state, [{ event: LifecycleEvent.StartRequested({ id: "api" }), now: 21 }]));
    expect(state.services.get("api")?.relaunchForced).toBe(true);

    const result = run(state, [
      {
        event: LifecycleEvent.Exited({
          id: "api",
          generation: 1,
          cause: undefined,
          requested: true,
        }),
        now: 30,
      },
    ]);
    expect(tagsOf(result.commandsByStep[0])).toEqual(["Launch"]);
    expect(commandTagged(at(result.commandsByStep, 0), "Launch").generation).toBe(2);
  });

  it("admits a cold inspector acquisition before the first readiness check while ordinary traffic still waits", () => {
    let state = initialState(makeGraph([lazy("functions")]), 0);
    ({ state } = run(state, [{ event: open("functions", 1), now: 0 }]));
    const generation = startingGeneration(state, "functions");
    expect(state.services.get("functions")?.waiters.size).toBe(1);

    const inspectorQueued = run(state, [
      {
        event: LifecycleEvent.ConnectionOpened({
          id: "functions",
          waiterId: 2,
          requireReady: false,
        }),
        now: 1,
      },
    ]);
    expect(tagsOf(inspectorQueued.commandsByStep[0])).toEqual(["ArmWaiterTimeout"]);
    state = inspectorQueued.state;

    const result = run(state, [
      { event: LifecycleEvent.SessionAvailable({ id: "functions", generation }), now: 2 },
    ]);
    expect(tagsOf(result.commandsByStep[0])).toEqual(["AdmitConnection"]);
    expect(commandTagged(at(result.commandsByStep, 0), "AdmitConnection").waiterId).toBe(2);
    expect(result.state.services.get("functions")?.waiters.size).toBe(1);

    const ready = run(result.state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "functions", generation }), now: 3 },
    ]);
    expect(tagsOf(ready.commandsByStep[0])).toEqual(["AdmitConnection"]);
    expect(commandTagged(at(ready.commandsByStep, 0), "AdmitConnection").waiterId).toBe(1);
  });

  it("re-arms the idle timer once demand returns and readiness later recovers, instead of staying armed forever", () => {
    let state = initialState(makeGraph([lazy("api")]), 0);
    ({ state } = run(state, [{ event: open("api", 1), now: 0 }]));
    ({ state } = run(state, [
      { event: LifecycleEvent.LaunchSucceeded({ id: "api", generation: 1 }), now: 10 },
    ]));
    ({ state } = run(state, [{ event: LifecycleEvent.ConnectionClosed({ id: "api" }), now: 20 }]));
    expect(state.services.get("api")?.idleArmedEpoch).toBe(1);

    ({ state } = run(state, [
      { event: LifecycleEvent.ReadinessLost({ id: "api", generation: 1, cause: "blip" }), now: 30 },
    ]));
    expect(state.services.get("api")?.idleArmedEpoch).toBe(1);

    ({ state } = run(state, [{ event: open("api", 2), now: 40 }]));
    expect(state.services.get("api")?.idleArmedEpoch).toBeUndefined();

    const staleElapse = run(state, [
      { event: LifecycleEvent.IdleElapsed({ id: "api", generation: 1, epoch: 1 }), now: 50 },
    ]);
    expect(staleElapse.commandsByStep[0]).toEqual([]);

    ({ state } = run(state, [
      { event: LifecycleEvent.WaiterExpired({ id: "api", waiterId: 2 }), now: 120_040 },
    ]));
    ({ state } = run(state, [
      { event: LifecycleEvent.ReadinessRecovered({ id: "api", generation: 1 }), now: 120_041 },
    ]));
    expect(state.services.get("api")?.idleArmedEpoch).toBe(2);
  });
});
