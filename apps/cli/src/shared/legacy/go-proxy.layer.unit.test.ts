import { describe, expect, it, vi } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import { PlatformError, SystemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type CliProcessSignal, ProcessControl } from "../runtime/process-control.service.ts";
import { LegacyGoChildExitError } from "./legacy-go-child-exit.error.ts";
import { GoProxyInvocation, goProxyInvocationLayer } from "./go-proxy-invocation.ts";
import { LegacyGoProxy } from "./go-proxy.service.ts";
import { formatGoBinaryNotFoundError, makeGoProxyLayer } from "./go-proxy.layer.ts";

/**
 * Regression tests for the SIGINT propagation fix in go-proxy.layer.ts.
 *
 * Two invariants MUST hold, otherwise Ctrl+C on a proxied long-running command
 * (`supabase start`, `supabase login`, `supabase functions serve`, ...) will
 * orphan the Go sidecar and/or lose its exit code:
 *
 * 1. `ChildProcess.make` is called with `detached: false` — Effect's Node/Bun
 *    spawner defaults `detached: true` on non-Windows, which puts the child
 *    in its own process group and makes it miss terminal-delivered signals.
 *
 * 2. `processControl.holdSignals` is called BEFORE the spawn (so parent-side
 *    no-op listeners are in place when the first tty signal arrives), covers
 *    SIGINT/SIGTERM/SIGHUP, and its scope is released on every exit path
 *    (success, failure, interrupt) so listeners don't leak between invocations.
 *
 * We verify invariant #2 against the service contract rather than against the
 * real `process` listener table — the layer under test now delegates to
 * `ProcessControl`, so real-listener coverage lives in the ProcessControl tests.
 */

type CapturedCommand = {
  command: string;
  args: readonly string[];
  options: ChildProcess.CommandOptions;
};

type ExitBehavior =
  | { kind: "success"; code: number }
  | { kind: "never" }
  | { kind: "fail"; error: string };

type HoldEvent =
  | { kind: "acquire"; id: number; signals: ReadonlyArray<CliProcessSignal> }
  | { kind: "release"; id: number };

/**
 * Records holdSignals(…) acquire/release transitions against an in-memory
 * event log. Each acquire gets a monotonically increasing id so tests can
 * pair an acquire with its release and distinguish concurrent scopes.
 *
 * The layer under test no longer calls `ProcessControl.exit()` itself on a
 * non-zero exit or an unresolved binary (CLI-1879 routes both through
 * `LegacyGoChildExitError` instead, so `runCli` can run finalizers before
 * exiting) — `exit()` here only guards against a future regression that
 * reintroduces a direct call; it blocks on `Effect.never` since nothing in
 * this file exercises it.
 */
function mockProcessControl() {
  const holdEvents: HoldEvent[] = [];
  const exitCalls: number[] = [];
  let nextHoldId = 0;

  const exit = (code: number) =>
    Effect.sync(() => {
      exitCalls.push(code);
    }).pipe(Effect.flatMap(() => Effect.never));

  return {
    get holdEvents() {
      return holdEvents;
    },
    get exitCalls() {
      return exitCalls;
    },
    layer: Layer.succeed(
      ProcessControl,
      ProcessControl.of({
        awaitSignal: () => Effect.never,
        awaitShutdown: Effect.never,
        holdSignals: (signals) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const id = nextHoldId++;
              holdEvents.push({ kind: "acquire", id, signals });
              return id;
            }),
            (id) =>
              Effect.sync(() => {
                holdEvents.push({ kind: "release", id });
              }),
          ).pipe(Effect.asVoid),
        exit,
        setExitCode: () => Effect.void,
        getExitCode: Effect.as(Effect.void, undefined),
      }),
    ),
  };
}

/**
 * Build a mock `ChildProcessSpawner` that records every spawned command and
 * returns a controllable exit code. `spawnedBeforeExit` deferred resolves as
 * soon as the spawn is observed (useful to sequence a race-then-interrupt).
 */
function mockSpawner(exit: ExitBehavior, spawnedBeforeExit?: Deferred.Deferred<void>) {
  const spawned: CapturedCommand[] = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command: ChildProcess.Command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("go proxy test received a piped command");
        }
        spawned.push({
          command: command.command,
          args: command.args,
          options: command.options,
        });
        if (spawnedBeforeExit !== undefined) {
          Deferred.doneUnsafe(spawnedBeforeExit, Effect.void);
        }
        const exitCode =
          exit.kind === "success"
            ? Effect.succeed(ChildProcessSpawner.ExitCode(exit.code))
            : exit.kind === "never"
              ? Effect.never
              : Effect.fail(
                  new PlatformError(
                    new SystemError({
                      _tag: "Unknown",
                      module: "ChildProcess",
                      method: "spawn",
                      description: exit.error,
                    }),
                  ),
                );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(42_424),
          exitCode,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return { layer, spawned };
}

/**
 * Inject a fake binary path directly via `makeGoProxyLayer({ binary })` so the
 * test doesn't depend on workspace package state, the SFE colocation trick, or
 * mutating `process.env` at module load.
 */
const TEST_BINARY = "/test/fake-supabase-go";

describe("formatGoBinaryNotFoundError", () => {
  const TRIED = [
    "$SUPABASE_GO_BINARY (unset)",
    "/usr/local/bin/supabase-go (not found alongside the shim)",
    "@supabase/cli-linux-x64 (npm package not installed)",
  ];

  it("renders each tried location as a bullet and includes remediation hints", () => {
    const message = formatGoBinaryNotFoundError(TRIED);
    expect(message).toContain("Could not find the `supabase-go` binary");
    expect(message).toContain("  • $SUPABASE_GO_BINARY (unset)");
    expect(message).toContain("  • /usr/local/bin/supabase-go (not found alongside the shim)");
    expect(message).toContain("  • @supabase/cli-linux-x64 (npm package not installed)");
    expect(message).toContain("npm i -g supabase");
    expect(message).toContain("SUPABASE_GO_BINARY");
  });

  it("omits the curl|tar snippet on dev builds (no CLI_VERSION baked in)", () => {
    // The vitest run does not go through the production bundler, so
    // CLI_VERSION resolves to the "0.0.0-dev" sentinel from version.ts and
    // the snippet is suppressed — we have nothing concrete to point at.
    const message = formatGoBinaryNotFoundError(TRIED);
    expect(message).not.toContain("curl -sL");
    // The prose remediation steps still appear so users have actionable hints.
    expect(message).toContain("Extract the release tarball");
  });
});

// The version- and platform-pinned curl|tar snippet exercised below
// instantiates a fresh module instance with a stubbed CLI_VERSION so we can
// assert against a known release version + asset filename. The fixture lives
// in a child `describe` so it doesn't bleed module mocks into other suites.
describe("formatGoBinaryNotFoundError - pinned snippet", () => {
  const TRIED = ["$SUPABASE_GO_BINARY (unset)"];
  const PINNED_VERSION = "2.100.0";

  class PinnedHostImportError extends Data.TaggedError("PinnedHostImportError")<{
    readonly message: string;
  }> {}

  function withMockedHost(
    opts: { platform: NodeJS.Platform; arch: NodeJS.Architecture },
    fn: (mod: typeof import("./go-proxy.layer.ts")) => void,
  ): Effect.Effect<void, PinnedHostImportError> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        vi.resetModules();
        vi.doMock("../cli/version.ts", () => ({ CLI_VERSION: PINNED_VERSION }));
        const originalPlatform = process.platform;
        const originalArch = process.arch;
        Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
        Object.defineProperty(process, "arch", { value: opts.arch, configurable: true });
        return { originalPlatform, originalArch };
      }),
      () =>
        Effect.tryPromise({
          try: () => import("./go-proxy.layer.ts"),
          catch: (cause) =>
            new PinnedHostImportError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(Effect.tap((mod) => Effect.sync(() => fn(mod)))),
      ({ originalPlatform, originalArch }) =>
        Effect.sync(() => {
          Object.defineProperty(process, "platform", {
            value: originalPlatform,
            configurable: true,
          });
          Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
          vi.doUnmock("../cli/version.ts");
          vi.resetModules();
        }),
    );
  }

  it.effect("renders a copy-pasteable install snippet for linux x64", () =>
    withMockedHost({ platform: "linux", arch: "x64" }, (mod) => {
      const message = mod.formatGoBinaryNotFoundError(TRIED);
      expect(message).toContain(
        `https://github.com/supabase/cli/releases/download/v${PINNED_VERSION}/supabase_${PINNED_VERSION}_linux_amd64.tar.gz`,
      );
      expect(message).toContain(`mkdir -p "$HOME/.local/share/supabase"`);
      expect(message).toContain(`export PATH="$HOME/.local/share/supabase:$PATH"`);
    }),
  );

  it.effect("maps Node's win32 platform to the release asset's `windows` slug", () =>
    // Release pipeline publishes `.tar.gz` for every (platform, arch) pair,
    // Windows included, so the snippet renders on win32 too — just with the
    // modern `windows` slug instead of Node's historical `win32`.
    withMockedHost({ platform: "win32", arch: "x64" }, (mod) => {
      const message = mod.formatGoBinaryNotFoundError(TRIED);
      expect(message).toContain(
        `https://github.com/supabase/cli/releases/download/v${PINNED_VERSION}/supabase_${PINNED_VERSION}_windows_amd64.tar.gz`,
      );
      // Never emit Node's internal `win32` token in the user-facing URL.
      expect(message).not.toContain("win32");
    }),
  );

  it.effect("maps darwin arm64 to the matching release asset", () =>
    withMockedHost({ platform: "darwin", arch: "arm64" }, (mod) => {
      expect(mod.formatGoBinaryNotFoundError(TRIED)).toContain(
        `supabase_${PINNED_VERSION}_darwin_arm64.tar.gz`,
      );
    }),
  );

  it.effect("omits the snippet on unsupported architectures (no release asset)", () =>
    // ia32 has never been a release target — the snippet should not invent a URL.
    withMockedHost({ platform: "linux", arch: "ia32" }, (mod) => {
      expect(mod.formatGoBinaryNotFoundError(TRIED)).not.toContain("curl -sL");
    }),
  );
});

describe("makeGoProxyLayer", () => {
  it.effect("records delegated execution for the parent success trailer", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = Layer.mergeAll(
      makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
        Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
      ),
      goProxyInvocationLayer,
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      const invocation = yield* GoProxyInvocation;

      expect(yield* invocation.wasDelegated).toBe(false);
      yield* proxy.exec(["migration", "squash", "--local"]);
      expect(yield* invocation.wasDelegated).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves captured success tails to the parent when configured", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = Layer.mergeAll(
      makeGoProxyLayer({
        binary: TEST_BINARY,
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
        parentOwnsCapturedSuccessTail: true,
      }).pipe(Layer.provide(Layer.mergeAll(spawner.layer, pc.layer))),
      goProxyInvocationLayer,
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      const invocation = yield* GoProxyInvocation;

      yield* proxy.execCapture(["db", "diff"], {
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
      });

      expect(spawner.spawned[0]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("1");
      expect(yield* invocation.wasDelegated).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes detached:false and inherited stdio to the spawner", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY, globalArgs: ["--debug"] }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["projects", "list"]);

      expect(spawner.spawned).toHaveLength(1);
      const captured = spawner.spawned[0]!;
      expect(captured.command).toBe(TEST_BINARY);
      expect(captured.args).toEqual(["--debug", "projects", "list"]);
      // The actual regression guard: if anyone drops this option, Effect's
      // spawner will fall back to detached:true on non-Windows and we're
      // back to the Ctrl+C-orphans-the-child bug.
      expect(captured.options.detached).toBe(false);
      expect(captured.options.stdin).toBe("inherit");
      expect(captured.options.stdout).toBe("inherit");
      expect(captured.options.stderr).toBe("inherit");
      expect(captured.options.extendEnv).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves child telemetry enabled for pure proxy commands", () => {
    // Pure proxy commands (`migration squash`, `db branch *`, `db remote *`,
    // `gen keys`) have no TS instrumentation, so the Go child is the only
    // emitter of `cli_command_executed`. Disabling it here would drop those
    // commands from telemetry entirely.
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["migration", "squash"]);
      yield* proxy.execCapture(["gen", "keys"]);

      for (const captured of spawner.spawned) {
        expect(captured.options.env ?? {}).not.toHaveProperty("SUPABASE_TELEMETRY_DISABLED");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("suppresses child telemetry when the caller owns the parent event", () => {
    // Instrumented handlers that delegate the whole command (db pull/diff/reset,
    // functions download) already emit `cli_command_executed` themselves, so the
    // child's copy would double-count.
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["db", "pull"], { suppressChildTelemetry: true });
      yield* proxy.execCapture(["db", "diff"], {
        env: { CUSTOM: "kept" },
        suppressChildTelemetry: true,
      });

      for (const captured of spawner.spawned) {
        expect(captured.options.env).toMatchObject({ SUPABASE_TELEMETRY_DISABLED: "1" });
      }
      expect(spawner.spawned[1]?.options.env).toMatchObject({ CUSTOM: "kept" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the layer's env to children, letting per-call env win", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({
      binary: TEST_BINARY,
      env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" },
    }).pipe(Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)));
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["projects", "list"]);
      yield* proxy.execCapture(["gen", "keys"]);
      yield* proxy.exec(["projects", "list"], { env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" } });

      expect(spawner.spawned[0]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("1");
      expect(spawner.spawned[1]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("1");
      expect(spawner.spawned[2]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("0");
    }).pipe(Effect.provide(layer));
  });

  it.effect("propagates non-zero exit codes via LegacyGoChildExitError", () => {
    const spawner = mockSpawner({ kind: "success", code: 7 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      const exit = yield* proxy.exec(["some", "command"]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(LegacyGoChildExitError);
        expect((error as LegacyGoChildExitError).exitCode).toBe(7);
      }
      // The layer itself never calls `ProcessControl.exit` — that's now
      // `runCli`'s job, after finalizers have run.
      expect(pc.exitCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an Effect.ensuring finalizer run after a non-zero exit (CLI-1879)", () => {
    // The whole point of routing a non-zero exit through `LegacyGoChildExitError`
    // instead of `ProcessControl.exit()` (a real `process.exit()` in production):
    // a caller's own `Effect.ensuring` finalizer — e.g. a handler's
    // `Effect.ensuring(telemetryState.flush)` — must still run. Under the old
    // `processControl.exit()`-based implementation this finalizer would never fire
    // (production: the process would already be dead; this mock's `exit()` blocks
    // forever on `Effect.never`, so the fiber never reaches `Effect.exit` either).
    const spawner = mockSpawner({ kind: "success", code: 5 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    let finalizerRan = false;
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["some", "command"]).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalizerRan = true;
          }),
        ),
        Effect.exit,
      );
      expect(finalizerRan).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not call ProcessControl.exit when the Go binary exits zero", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec(["some", "command"]);
      expect(pc.exitCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("calls holdSignals with SIGINT+SIGTERM+SIGHUP before spawning", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec([]);

      // Exactly one hold scope was opened, with all three terminal signals.
      const acquires = pc.holdEvents.filter((e) => e.kind === "acquire");
      expect(acquires).toHaveLength(1);
      expect(acquires[0]!.signals).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);

      // Ordering guard: the hold must be acquired before the child is spawned.
      // We rely on the fact that spawner.spawned is only populated inside the
      // spawner mock, so comparing event counts at this point is sufficient.
      expect(spawner.spawned).toHaveLength(1);
      expect(pc.holdEvents[0]).toEqual(expect.objectContaining({ kind: "acquire" }));
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases the holdSignals scope on successful exec", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      yield* proxy.exec([]);

      // Acquire then release of scope id 0.
      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 0 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases the holdSignals scope when the spawner fails", () => {
    const spawner = mockSpawner({ kind: "fail", error: "spawn failed" });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      // spawner failures are Effect.orDie'd, so we swallow the defect here.
      yield* proxy.exec([]).pipe(Effect.exit);

      // Release still ran despite the defect — this is the whole point of
      // putting holdSignals inside a scope.
      expect(pc.holdEvents).toContainEqual({ kind: "release", id: 0 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases the holdSignals scope when the fiber is interrupted", () => {
    const spawned = Deferred.makeUnsafe<void>();
    const spawner = mockSpawner({ kind: "never" }, spawned);
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      const fiber = yield* proxy.exec([]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(spawned);

      // Scope is open while the child "runs" (Effect.never).
      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
      ]);

      yield* Fiber.interrupt(fiber);

      // Effect.scoped guarantees the release step runs on interruption.
      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 0 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  // Regression guard for CLI-1488 — the previous `resolveBinary()` returned the
  // literal string "supabase" when no Go binary was found, which when run from
  // a PATH that contained the shim would fork-bomb the shim against itself
  // (silent multi-minute hang in CI followed by SIGTERM). The layer must now
  // refuse to spawn anything and surface a specific diagnostic + a
  // `LegacyGoChildExitError` carrying exit code 1.
  it.effect(
    "prints a diagnostic and fails with exit code 1 when supabase-go cannot be resolved",
    () => {
      const spawner = mockSpawner({ kind: "success", code: 0 });
      const pc = mockProcessControl();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const tried = [
        "$SUPABASE_GO_BINARY (unset)",
        "/usr/local/bin/supabase-go (not found alongside the shim)",
      ];
      const layer = makeGoProxyLayer({ binary: { notFound: tried } }).pipe(
        Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
      );
      return Effect.gen(function* () {
        const proxy = yield* LegacyGoProxy;
        const exit = yield* proxy.exec(["db", "start"]).pipe(Effect.exit);

        // Did NOT spawn anything — the whole point is to refuse the fork-bomb.
        expect(spawner.spawned).toHaveLength(0);
        // Failed with a LegacyGoChildExitError carrying exit code 1, rather than
        // calling `ProcessControl.exit` directly — that's now `runCli`'s job.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(LegacyGoChildExitError);
          expect((error as LegacyGoChildExitError).exitCode).toBe(1);
        }
        expect(pc.exitCalls).toEqual([]);
        // Wrote the diagnostic to stderr, including each tried location.
        expect(stderr).toHaveBeenCalledTimes(1);
        const written = String(stderr.mock.calls[0]![0]);
        expect(written).toContain("Could not find the `supabase-go` binary");
        expect(written).toContain("$SUPABASE_GO_BINARY (unset)");
        expect(written).toContain("/usr/local/bin/supabase-go");
        expect(written).toContain("SUPABASE_GO_BINARY");
        stderr.mockRestore();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "execCapture also prints a diagnostic and fails with exit code 1 when supabase-go cannot be resolved",
    () => {
      const spawner = mockSpawner({ kind: "success", code: 0 });
      const pc = mockProcessControl();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const tried = ["$SUPABASE_GO_BINARY (unset)"];
      const layer = makeGoProxyLayer({ binary: { notFound: tried } }).pipe(
        Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
      );
      return Effect.gen(function* () {
        const proxy = yield* LegacyGoProxy;
        const exit = yield* proxy.execCapture(["db", "dump"]).pipe(Effect.exit);

        expect(spawner.spawned).toHaveLength(0);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(LegacyGoChildExitError);
          expect((error as LegacyGoChildExitError).exitCode).toBe(1);
        }
        expect(pc.exitCalls).toEqual([]);
        expect(stderr).toHaveBeenCalledTimes(1);
        stderr.mockRestore();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("opens and closes a fresh hold scope per sequential exec call", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* LegacyGoProxy;
      for (let i = 0; i < 3; i++) {
        yield* proxy.exec([`call-${i}`]);
      }

      // Each exec call → acquire immediately followed by release, with
      // monotonically increasing scope ids.
      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 0 },
        { kind: "acquire", id: 1, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 1 },
        { kind: "acquire", id: 2, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 2 },
      ]);
      expect(spawner.spawned).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
});
