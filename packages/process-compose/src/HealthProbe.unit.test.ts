// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test uses a temporary filesystem fixture at the native boundary.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test uses native path handling for its temporary fixture.
import { join } from "node:path";
import * as Net from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test needs a real HTTP server to verify request headers.
import * as Http from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { layer as BunChildProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as BunPathLayer } from "@effect/platform-bun/BunPath";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Predicate, Sink, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { runHealthProbe } from "./HealthProbe.ts";
import type { HealthCheckConfig, ProbeConfig } from "./ServiceDef.ts";

const platformLayer = Layer.mergeAll(
  BunChildProcessSpawnerLayer.pipe(Layer.provide(Layer.mergeAll(BunFileSystemLayer, BunPathLayer))),
  BunFileSystemLayer,
  BunPathLayer,
  FetchHttpClient.layer,
);

const sequenceProbeLayer = (results: ReadonlyArray<boolean>) => {
  let calls = 0;
  return {
    layer: Layer.mergeAll(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            const result = results[calls] ?? results.at(-1) ?? false;
            calls++;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(2000 + calls),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result ? 0 : 1)),
              isRunning: Effect.succeed(false),
              stdin: Sink.drain,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        ),
      ),
      FetchHttpClient.layer,
    ),
    get calls() {
      return calls;
    },
  };
};

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
        onHealthy: Effect.gen(function* () {
          healthy = true;
          yield* Deferred.succeed(healthySignal, void 0);
        }),
        onUnhealthy: Effect.gen(function* () {
          healthy = false;
          yield* Deferred.succeed(unhealthySignal, void 0);
        }),
      },
    };
    return { healthySignal, unhealthySignal, config, isHealthy: () => healthy };
  });

describe("HealthProbe", () => {
  it.live("aborts an in-flight HTTP probe when its fiber is interrupted", () => {
    const originalFetch = globalThis.fetch;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- The test fetch stub signals its start synchronously before hanging.
        Effect.runSync(Deferred.succeed(started, void 0));
        // oxlint-disable-next-line effecttsgo/new-promise -- The test fetch stub must remain pending until interruption.
        return new Promise<Response>(() => undefined);
      }) as typeof fetch;

      const { config } = yield* setupProbe({
        _tag: "Http",
        scheme: "http",
        host: "127.0.0.1",
        port: 80,
        path: "/health",
      });
      const fiber = yield* Effect.forkChild(runHealthProbe(config), { startImmediately: true });
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(aborted).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.sync(() => (globalThis.fetch = originalFetch))),
      Effect.provide(platformLayer),
    );
  });

  it.live("passes configured headers to HTTP probes", () => {
    return Effect.gen(function* () {
      const server = Http.createServer((request, response) => {
        if (request.headers.host === "realtime-dev") {
          response.writeHead(200).end();
        } else {
          response.writeHead(404).end();
        }
      });
      const port = yield* Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address !== null && typeof address !== "string") {
            resume(Effect.succeed(address.port));
          }
        });
        return Effect.sync(() => server.close());
      });

      const fetchWithHostHeader = Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input : input.url;
          const requestHeaders =
            init?.headers === undefined
              ? undefined
              : Array.isArray(init.headers)
                ? Object.fromEntries(init.headers)
                : init.headers instanceof Headers
                  ? Object.fromEntries(init.headers.entries())
                  : init.headers;
          // oxlint-disable-next-line effecttsgo/new-promise -- The fetch replacement adapts node:http callbacks to the Fetch contract.
          return new Promise<Response>((resolve, reject) => {
            const request = Http.request(
              url,
              {
                method: init?.method,
                headers: requestHeaders,
              },
              (response) => {
                const chunks: Array<Uint8Array> = [];
                response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
                response.on("end", () => {
                  const responseHeaders = Object.fromEntries(
                    Object.entries(response.headers).flatMap(([key, value]) =>
                      value === undefined
                        ? []
                        : [[key, Array.isArray(value) ? value.join(", ") : value]],
                    ),
                  );
                  resolve(
                    new Response(Buffer.concat(chunks), {
                      status: response.statusCode,
                      headers: responseHeaders,
                    }),
                  );
                });
              },
            );
            request.on("error", reject);
            request.end(init?.body as string | Uint8Array | undefined);
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      );

      const { healthySignal, config, isHealthy } = yield* setupProbe({
        _tag: "Http",
        scheme: "http",
        host: "127.0.0.1",
        port,
        path: "/api/ping",
        headers: { Host: "realtime-dev" },
      });
      const fiber = yield* Effect.forkChild(
        runHealthProbe(config).pipe(
          Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithHostHeader)),
        ),
      );
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(5)));
      expect(isHealthy()).toBe(true);
      yield* Fiber.interrupt(fiber);
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
    }).pipe(Effect.provide(platformLayer));
  });

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
      const layer = Layer.mergeAll(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.sync(() => {
              if (Predicate.isTagged(command, "StandardCommand")) {
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
                unref: Effect.succeed(Effect.void),
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
            }),
          ),
        ),
        FetchHttpClient.layer,
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

  it.live("uses failureThreshold for startup when no startup threshold is configured", () => {
    const probe = sequenceProbeLayer([false]);
    return Effect.gen(function* () {
      const { unhealthySignal, config } = yield* setupProbe(
        { _tag: "Exec", command: "check", args: [] },
        { failureThreshold: 2 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(unhealthySignal).pipe(Effect.timeout(Duration.seconds(1)));
      expect(probe.calls).toBe(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probe.layer));
  });

  it.live("allows a larger startup threshold than the liveness threshold", () => {
    const probe = sequenceProbeLayer([false]);
    return Effect.gen(function* () {
      const { unhealthySignal, config } = yield* setupProbe(
        { _tag: "Exec", command: "check", args: [] },
        { startupFailureThreshold: 4, failureThreshold: 2 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(unhealthySignal).pipe(Effect.timeout(Duration.seconds(1)));
      expect(probe.calls).toBe(4);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probe.layer));
  });

  it.live("recovers on the final startup probe without becoming unhealthy", () => {
    const probe = sequenceProbeLayer([false, false, true]);
    return Effect.gen(function* () {
      const { healthySignal, unhealthySignal, config } = yield* setupProbe(
        { _tag: "Exec", command: "check", args: [] },
        { startupFailureThreshold: 3, failureThreshold: 1 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(1)));
      expect(probe.calls).toBe(3);
      expect(yield* Deferred.isDone(unhealthySignal)).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probe.layer));
  });

  it.live("uses the liveness threshold after the first healthy transition", () => {
    const probe = sequenceProbeLayer([true, false, false]);
    return Effect.gen(function* () {
      const { healthySignal, unhealthySignal, config } = yield* setupProbe(
        { _tag: "Exec", command: "check", args: [] },
        { startupFailureThreshold: 5, failureThreshold: 2 },
      );
      const fiber = yield* Effect.forkChild(runHealthProbe(config));
      yield* Deferred.await(healthySignal).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Deferred.await(unhealthySignal).pipe(Effect.timeout(Duration.seconds(1)));
      expect(probe.calls).toBe(3);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probe.layer));
  });

  it.live("does not re-enable startup tolerance after an unhealthy recovery", () => {
    const probe = sequenceProbeLayer([true, false, false, true, false, false]);
    return Effect.gen(function* () {
      let healthyTransitions = 0;
      let unhealthyTransitions = 0;
      const secondUnhealthy = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        runHealthProbe({
          name: "test",
          healthCheck: {
            probe: { _tag: "Exec", command: "check", args: [] },
            periodSeconds: 0.01,
            startupFailureThreshold: 5,
            failureThreshold: 2,
          },
          callbacks: {
            onHealthy: Effect.sync(() => {
              healthyTransitions++;
            }),
            onUnhealthy: Effect.gen(function* () {
              unhealthyTransitions++;
              if (unhealthyTransitions === 2) {
                yield* Deferred.succeed(secondUnhealthy, void 0);
              }
            }),
          },
        }),
      );

      yield* Deferred.await(secondUnhealthy).pipe(Effect.timeout(Duration.seconds(1)));
      expect(probe.calls).toBe(6);
      expect(healthyTransitions).toBe(2);
      expect(unhealthyTransitions).toBe(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probe.layer));
  });

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
      // oxlint-disable-next-line effecttsgo/try-catch-in-effect-gen -- Native unlink cleanup is best-effort test fixture teardown.
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
