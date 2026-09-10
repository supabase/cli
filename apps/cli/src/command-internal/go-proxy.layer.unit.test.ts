import { describe, expect, it, vi } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  type CliProcessSignal,
  ProcessControl,
} from "../shared/runtime/process-control.service.ts";
import { GoChildExitError } from "./go-child-exit.error.ts";
import { GoProxyInvocation, goProxyInvocationLayer } from "./go-proxy-invocation.ts";
import { GoProxy } from "./go-proxy.service.ts";
import { formatGoBinaryNotFoundError, makeGoProxyLayer } from "./go-proxy.layer.ts";

/**
 * Regression tests for SIGINT propagation: Ctrl+C on a proxied long-running command must reach
 * the Go sidecar and not lose its exit code. `ChildProcess.make` must be called with
 * `detached: false`, and `processControl.holdSignals` must be acquired before spawn (covering
 * SIGINT/SIGTERM/SIGHUP) and released on every exit path.
 */

type CapturedCommand = {
  command: string;
  args: readonly string[];
  options: {
    detached?: boolean;
    stdin?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    cwd?: string;
    env?: Record<string, string>;
    extendEnv?: boolean;
  };
};

type ExitBehavior =
  | { kind: "success"; code: number }
  | { kind: "never" }
  | { kind: "fail"; error: string };

type HoldEvent =
  | { kind: "acquire"; id: number; signals: ReadonlyArray<CliProcessSignal> }
  | { kind: "release"; id: number };

/**
 * Records holdSignals(...) acquire/release transitions. Each acquire gets a monotonically
 * increasing id so tests can pair an acquire with its release.
 *
 * `exit()` here only guards against a regression that reintroduces a direct
 * `ProcessControl.exit()` call; it blocks on `Effect.never` since nothing in this file exercises
 * it.
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
        getExitCode: Effect.succeed(undefined),
      }),
    ),
  };
}

/**
 * Builds a mock `ChildProcessSpawner` that records every spawned command and returns a
 * controllable exit code. `spawnedBeforeExit` resolves as soon as the spawn is observed, to
 * sequence a race-then-interrupt.
 */
function mockSpawner(exit: ExitBehavior, spawnedBeforeExit?: Deferred.Deferred<void>) {
  const spawned: CapturedCommand[] = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command: any) =>
      Effect.sync(() => {
        const cmd = command as CapturedCommand & { _tag: string };
        spawned.push({
          command: cmd.command,
          args: cmd.args,
          options: cmd.options,
        });
        if (spawnedBeforeExit !== undefined) {
          Deferred.doneUnsafe(spawnedBeforeExit, Effect.void);
        }
        const exitCode =
          exit.kind === "success"
            ? Effect.succeed(ChildProcessSpawner.ExitCode(exit.code))
            : exit.kind === "never"
              ? Effect.never
              : Effect.fail(new Error(exit.error) as any);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(42_424),
          exitCode,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain as any,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain as any,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return { layer, spawned };
}

/** Injected directly via `makeGoProxyLayer({ binary })` so tests don't depend on workspace package state or `process.env`. */
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
    const message = formatGoBinaryNotFoundError(TRIED);
    expect(message).not.toContain("curl -sL");
    expect(message).toContain("Extract the release tarball");
  });
});

// Instantiates a fresh module with a stubbed CLI_VERSION to assert against a known release
// version + asset filename; nested in its own describe so the module mock doesn't bleed into
// other suites.
describe("formatGoBinaryNotFoundError - pinned snippet", () => {
  const TRIED = ["$SUPABASE_GO_BINARY (unset)"];
  const PINNED_VERSION = "2.100.0";

  async function withMockedHost(
    opts: { platform: NodeJS.Platform; arch: NodeJS.Architecture },
    fn: (mod: typeof import("./go-proxy.layer.ts")) => void | Promise<void>,
  ): Promise<void> {
    vi.resetModules();
    vi.doMock("../shared/cli/version.ts", () => ({ CLI_VERSION: PINNED_VERSION }));
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
    Object.defineProperty(process, "arch", { value: opts.arch, configurable: true });
    try {
      const mod = await import("./go-proxy.layer.ts");
      await fn(mod);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      vi.doUnmock("../cli/version.ts");
      vi.resetModules();
    }
  }

  it("renders a copy-pasteable install snippet for linux x64", async () => {
    await withMockedHost({ platform: "linux", arch: "x64" }, (mod) => {
      const message = mod.formatGoBinaryNotFoundError(TRIED);
      expect(message).toContain(
        `https://github.com/supabase/cli/releases/download/v${PINNED_VERSION}/supabase_${PINNED_VERSION}_linux_amd64.tar.gz`,
      );
      expect(message).toContain(`mkdir -p "$HOME/.local/share/supabase"`);
      expect(message).toContain(`export PATH="$HOME/.local/share/supabase:$PATH"`);
    });
  });

  it("maps Node's win32 platform to the release asset's `windows` slug", async () => {
    await withMockedHost({ platform: "win32", arch: "x64" }, (mod) => {
      const message = mod.formatGoBinaryNotFoundError(TRIED);
      expect(message).toContain(
        `https://github.com/supabase/cli/releases/download/v${PINNED_VERSION}/supabase_${PINNED_VERSION}_windows_amd64.tar.gz`,
      );
      expect(message).not.toContain("win32");
    });
  });

  it("maps darwin arm64 to the matching release asset", async () => {
    await withMockedHost({ platform: "darwin", arch: "arm64" }, (mod) => {
      expect(mod.formatGoBinaryNotFoundError(TRIED)).toContain(
        `supabase_${PINNED_VERSION}_darwin_arm64.tar.gz`,
      );
    });
  });

  it("omits the snippet on unsupported architectures (no release asset)", async () => {
    await withMockedHost({ platform: "linux", arch: "ia32" }, (mod) => {
      expect(mod.formatGoBinaryNotFoundError(TRIED)).not.toContain("curl -sL");
    });
  });
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
      const proxy = yield* GoProxy;
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
      const proxy = yield* GoProxy;
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
      const proxy = yield* GoProxy;
      yield* proxy.exec(["projects", "list"]);

      expect(spawner.spawned).toHaveLength(1);
      const captured = spawner.spawned[0]!;
      expect(captured.command).toBe(TEST_BINARY);
      expect(captured.args).toEqual(["--debug", "projects", "list"]);
      expect(captured.options.detached).toBe(false);
      expect(captured.options.stdin).toBe("inherit");
      expect(captured.options.stdout).toBe("inherit");
      expect(captured.options.stderr).toBe("inherit");
      expect(captured.options.extendEnv).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves child telemetry enabled for pure proxy commands", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* GoProxy;
      yield* proxy.exec(["migration", "squash"]);
      yield* proxy.execCapture(["gen", "keys"]);

      for (const captured of spawner.spawned) {
        expect(captured.options.env ?? {}).not.toHaveProperty("SUPABASE_TELEMETRY_DISABLED");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("suppresses child telemetry when the caller owns the parent event", () => {
    const spawner = mockSpawner({ kind: "success", code: 0 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* GoProxy;
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
      const proxy = yield* GoProxy;
      yield* proxy.exec(["projects", "list"]);
      yield* proxy.execCapture(["gen", "keys"]);
      yield* proxy.exec(["projects", "list"], { env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" } });

      expect(spawner.spawned[0]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("1");
      expect(spawner.spawned[1]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("1");
      expect(spawner.spawned[2]?.options.env?.SUPABASE_NO_UPDATE_NOTIFIER).toBe("0");
    }).pipe(Effect.provide(layer));
  });

  it.effect("propagates non-zero exit codes via GoChildExitError", () => {
    const spawner = mockSpawner({ kind: "success", code: 7 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    return Effect.gen(function* () {
      const proxy = yield* GoProxy;
      const exit = yield* proxy.exec(["some", "command"]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(GoChildExitError);
        expect((error as GoChildExitError).exitCode).toBe(7);
      }
      expect(pc.exitCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an Effect.ensuring finalizer run after a non-zero exit (CLI-1879)", () => {
    const spawner = mockSpawner({ kind: "success", code: 5 });
    const pc = mockProcessControl();
    const layer = makeGoProxyLayer({ binary: TEST_BINARY }).pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, pc.layer)),
    );
    let finalizerRan = false;
    return Effect.gen(function* () {
      const proxy = yield* GoProxy;
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
      const proxy = yield* GoProxy;
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
      const proxy = yield* GoProxy;
      yield* proxy.exec([]);

      const acquires = pc.holdEvents.filter((e) => e.kind === "acquire");
      expect(acquires).toHaveLength(1);
      expect(acquires[0]!.signals).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);

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
      const proxy = yield* GoProxy;
      yield* proxy.exec([]);

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
      const proxy = yield* GoProxy;
      // spawner failures are Effect.orDie'd, so we swallow the defect here.
      yield* proxy.exec([]).pipe(Effect.exit);

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
      const proxy = yield* GoProxy;
      const fiber = yield* proxy.exec([]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(spawned);

      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
      ]);

      yield* Fiber.interrupt(fiber);

      expect(pc.holdEvents).toEqual([
        { kind: "acquire", id: 0, signals: ["SIGINT", "SIGTERM", "SIGHUP"] },
        { kind: "release", id: 0 },
      ]);
    }).pipe(Effect.provide(layer));
  });

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
        const proxy = yield* GoProxy;
        const exit = yield* proxy.exec(["db", "start"]).pipe(Effect.exit);

        expect(spawner.spawned).toHaveLength(0);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(GoChildExitError);
          expect((error as GoChildExitError).exitCode).toBe(1);
        }
        expect(pc.exitCalls).toEqual([]);
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
        const proxy = yield* GoProxy;
        const exit = yield* proxy.execCapture(["db", "dump"]).pipe(Effect.exit);

        expect(spawner.spawned).toHaveLength(0);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(GoChildExitError);
          expect((error as GoChildExitError).exitCode).toBe(1);
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
      const proxy = yield* GoProxy;
      for (let i = 0; i < 3; i++) {
        yield* proxy.exec([`call-${i}`]);
      }

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
