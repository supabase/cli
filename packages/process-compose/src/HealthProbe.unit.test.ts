import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Net from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { layer as BunChildProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as BunPathLayer } from "@effect/platform-bun/BunPath";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runHealthProbe } from "./HealthProbe.ts";
import type { HealthCheckConfig, ProbeConfig } from "./ServiceDef.ts";

const platformLayer = BunChildProcessSpawnerLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystemLayer, BunPathLayer)),
);

const setupProbe = (probe: ProbeConfig, overrides?: Partial<HealthCheckConfig>) =>
  Effect.gen(function* () {
    let healthy = false;
    const healthySignal = yield* Deferred.make<void>();
    const unhealthySignal = yield* Deferred.make<void>();
    const config = {
      name: "test",
      healthCheck: {
        probe,
        initialDelaySeconds: 0,
        periodSeconds: 0.01,
        timeoutSeconds: 1,
        successThreshold: 1,
        failureThreshold: 2,
        ...overrides,
      },
      callbacks: {
        onHealthy: () =>
          Effect.gen(function* () {
            healthy = true;
            yield* Deferred.succeed(healthySignal, void 0);
          }),
        onUnhealthy: () =>
          Effect.gen(function* () {
            healthy = false;
            yield* Deferred.succeed(unhealthySignal, void 0);
          }),
      },
    };
    return { healthySignal, unhealthySignal, config, isHealthy: () => healthy };
  });

describe("HealthProbe", () => {
  it.live("Exec probes require explicit args", () =>
    Effect.sync(() => {
      // @ts-expect-error Exec probes must declare args explicitly.
      const _probe: ProbeConfig = {
        _tag: "Exec",
        command: "true",
      };

      expect(true).toBe(true);
    }),
  );

  it.live("transitions to Healthy with successful exec probe", () =>
    Effect.gen(function* () {
      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Exec",
        command: "true",
        args: [],
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("transitions to Healthy with structured exec probe args", () =>
    Effect.gen(function* () {
      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Exec",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("runs exec probes directly without shell indirection", () =>
    Effect.sync(() => {
      const spawned: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const layer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand") {
              spawned.push({
                command: command.command,
                args: command.args,
              });
            }

            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1234),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              stdin: Sink.drain,
              kill: () => Effect.void,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        ),
      );

      return Effect.gen(function* () {
        const { healthySignal, config } = yield* setupProbe({
          _tag: "Exec",
          command: "true",
          args: [],
        });
        const fiber = yield* Effect.forkChild(runHealthProbe(config));
        yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
        expect(spawned).toEqual([
          {
            command: "true",
            args: [],
          },
        ]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.flatten),
  );

  it.live("passes env to structured exec probes", () =>
    Effect.gen(function* () {
      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Exec",
        command: process.execPath,
        args: ["-e", "process.exit(process.env.SUPA_HEALTH_CHECK === 'ok' ? 0 : 1)"],
        env: { SUPA_HEALTH_CHECK: "ok" },
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("completes healthySignal Deferred on success", () =>
    Effect.gen(function* () {
      const { healthySignal, config } = yield* setupProbe({
        _tag: "Exec",
        command: "true",
        args: [],
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      const done = yield* Deferred.isDone(healthySignal);
      expect(done).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("never transitions to Healthy with always-failing exec probe", () =>
    Effect.gen(function* () {
      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Exec",
        command: "false",
        args: [],
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config));

      const exit = yield* Deferred.await(healthySignal).pipe(
        Effect.timeout(Duration.millis(300)),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(isHealthy()).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("respects initialDelaySeconds before first probe", () =>
    Effect.gen(function* () {
      const { healthySignal, config } = yield* setupProbe(
        { _tag: "Exec", command: "true", args: [] },
        { initialDelaySeconds: 0.2, periodSeconds: 0.01 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));

      // Signal should NOT be complete within 100ms (less than the 200ms initial delay)
      const earlyExit = yield* Deferred.await(healthySignal).pipe(
        Effect.timeout(Duration.millis(100)),
        Effect.exit,
      );
      expect(Exit.isFailure(earlyExit)).toBe(true);

      // After enough time, the signal should complete
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      const done = yield* Deferred.isDone(healthySignal);
      expect(done).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("respects successThreshold before marking Healthy", () =>
    Effect.gen(function* () {
      const { healthySignal, config, isHealthy } = yield* setupProbe(
        { _tag: "Exec", command: "true", args: [] },
        { successThreshold: 3, periodSeconds: 0.01 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));

      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("transitions to Healthy with successful TCP probe", () =>
    Effect.gen(function* () {
      // Start a real TCP server on a random port
      const server = Net.createServer();
      const port = yield* Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as Net.AddressInfo;
          resume(Effect.succeed(addr.port));
        });
      });

      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Tcp",
        host: "127.0.0.1",
        port,
      });

      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);

      // Close the server
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("never transitions to Healthy with closed TCP port", () =>
    Effect.gen(function* () {
      // Bind a server to get a random port, then close it so the port is not listening
      const port = yield* Effect.callback<number>((resume) => {
        const server = Net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as Net.AddressInfo;
          const p = addr.port;
          server.close(() => resume(Effect.succeed(p)));
        });
      });

      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Tcp",
        host: "127.0.0.1",
        port,
      });

      const fiber = yield* Effect.forkChild(runHealthProbe(config));

      const exit = yield* Deferred.await(healthySignal).pipe(
        Effect.timeout(Duration.millis(300)),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(isHealthy()).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("transitions to Unhealthy after failureThreshold failures following Healthy", () =>
    Effect.gen(function* () {
      const tempDir = mkdtempSync(join(tmpdir(), "health-probe-test-"));
      const flagFile = join(tempDir, "healthy");

      // Create the flag file so probe succeeds initially
      writeFileSync(flagFile, "");

      const { healthySignal, unhealthySignal, config, isHealthy } = yield* setupProbe(
        { _tag: "Exec", command: "test", args: ["-f", flagFile] },
        { periodSeconds: 0.01, successThreshold: 1, failureThreshold: 2 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));

      // Wait until healthy
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);

      // Remove the flag file so probe starts failing
      try {
        unlinkSync(flagFile);
      } catch {
        /* ignore */
      }

      yield* Deferred.await(unhealthySignal).pipe(Effect.timeout(Duration.seconds(5)));

      expect(isHealthy()).toBe(false);
      yield* Fiber.interrupt(fiber);
      rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(platformLayer)),
  );
});
