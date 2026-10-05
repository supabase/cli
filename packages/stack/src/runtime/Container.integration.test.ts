import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Context,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import {
  ContainerLaunchError,
  DOCKER_HOST_ALIAS,
  engineUnreachable,
  makeContainerRuntime,
  makeHostGateway,
  resolveEngineTarget,
  type ContainerProcess,
  type EngineTarget,
} from "./Container.ts";
import * as Owner from "../Owner.ts";
import * as StackNamespace from "../StackNamespace.ts";
import { makeDockerDatabaseStorage } from "../storage/DockerDatabaseStorage.ts";
import { reconcileContainerPassword } from "../services/Database.ts";
import { noContainerClaims } from "../../tests/claims.ts";

const image = await Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL("../../../../.bun-version", import.meta.url));
  const version = yield* fs.readFileString(file);
  return `oven/bun:${version.trim()}-slim`;
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
// An unpinned target: these tests exercise the container runtime, not endpoint pinning, so an
// empty argv prefix leaves every command exactly as it was before pinning existed.
const dockerTarget: EngineTarget = { engine: "docker", argv: [], daemonId: "test-daemon-id" };
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const stoppableIdleScript =
  "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)";

class ContainerTestError extends Data.TaggedError("ContainerTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

describe("container process adapter", () => {
  it.live("recognizes a cached pinned image without pulling", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      });
      yield* runtime.prepare(image);
      const repositoryDigest = yield* repoDigest(delegate, image);
      const digest = repositoryDigest.slice(repositoryDigest.indexOf("@") + 1);
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const pinnedImage = `${image}@${digest}`;
      const pullAttempted = yield* Ref.make(false);
      const spawner = makePullFailureSpawner(delegate, pullAttempted);
      yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      }).pipe(
        Effect.flatMap((runtime) => runtime.prepare(pinnedImage)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      expect(yield* Ref.get(pullAttempted)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps missing image pull failures observable", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const pullAttempted = yield* Ref.make(false);
      const spawner = makePullFailureSpawner(delegate, pullAttempted);
      const result = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      }).pipe(
        Effect.flatMap((runtime) =>
          runtime.prepare(`supabase-prepare-regression:${token}`).pipe(Effect.exit),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(pullAttempted)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("pull rejected");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("prepares, launches, streams, waits, and removes one exact container", () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({
            claims: noContainerClaims,
            target: dockerTarget,
            root: ".",
          });
          yield* runtime.prepare(image);
          const process = yield* runtime.launch({
            image,
            stackId: "a".repeat(64),
            instanceId: "fixture-output",
            env: { FIXTURE: "true" },
            args: [
              "-e",
              "console.log('stdout-marker'); console.error('stderr-marker'); process.exit(7)",
            ],
          });
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              process.stdout.pipe(Stream.decodeText, Stream.mkString),
              process.stderr.pipe(Stream.decodeText, Stream.mkString),
              process.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          expect(stdout).toContain("stdout-marker");
          expect(stderr).toContain("stderr-marker");
          expect(exitCode).toBe(7);
          return process.id;
        }),
      );
      expect(yield* exists(id)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("streams tool input and output and preserves a nonzero exit", () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({
            claims: noContainerClaims,
            target: dockerTarget,
            root: ".",
          });
          yield* runtime.prepare(image);
          const process = yield* runtime.launchCommand({
            image,
            stackId: "e".repeat(64),
            instanceId: "tool-input",
            env: {},
            args: [
              "-e",
              "const input = await Bun.stdin.text(); console.log(input); console.error('tool-error'); process.exit(7)",
            ],
          });
          const [, stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.make(new TextEncoder().encode("attached-input")).pipe(
                Stream.run(process.stdin),
              ),
              process.stdout.pipe(Stream.decodeText, Stream.mkString),
              process.stderr.pipe(Stream.decodeText, Stream.mkString),
              process.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          expect(stdout).toContain("attached-input");
          expect(stderr).toContain("tool-error");
          expect(exitCode).toBe(7);
          return process.id;
        }),
      );
      expect(yield* exists(id)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("maps the stack host alias to an explicit IPv4 host gateway only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        });
        yield* runtime.prepare(image);
        const process = yield* runtime.launchCommand({
          image,
          stackId: "e".repeat(64),
          instanceId: "host-alias",
          env: {},
          args: ["-e", "console.log(await Bun.file('/etc/hosts').text())"],
        });
        const [hosts, exitCode] = yield* Effect.all(
          [process.stdout.pipe(Stream.decodeText, Stream.mkString), process.exitCode],
          { concurrency: "unbounded" },
        );
        expect(exitCode).toBe(0);
        const addresses = hosts
          .split("\n")
          .map((line) => line.trim().split(/\s+/u))
          .filter(([, ...names]) => names.includes(DOCKER_HOST_ALIAS))
          .map(([address]) => address ?? "");
        expect(addresses.length).toBeGreaterThan(0);
        expect(addresses.every((address) => ipv4.test(address))).toBe(true);
        expect(yield* inspectExtraHosts(process.id)).toContain(
          `${DOCKER_HOST_ALIAS}:${addresses[0]}`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("probes the host gateway once for concurrent launches across runtimes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const hostGateway = yield* makeHostGateway;
        const makeRuntime = makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(delegate, probes, () => undefined),
          ),
        );
        const first = yield* makeRuntime;
        const second = yield* makeRuntime;
        yield* first.prepare(image);
        const processes = yield* Effect.all(
          [first, second].map((runtime, index) =>
            runtime.launchCommand({
              image,
              stackId: "e".repeat(64),
              instanceId: `host-alias-concurrent-${index}`,
              env: {},
              args: ["-e", "process.exit(0)"],
            }),
          ),
          { concurrency: "unbounded" },
        );
        expect(yield* Ref.get(probes)).toBe(1);
        for (const process of processes) {
          const aliases = (yield* inspectExtraHosts(process.id)).filter((entry) =>
            entry.startsWith(`${DOCKER_HOST_ALIAS}:`),
          );
          expect(aliases).toHaveLength(1);
          expect(aliases[0]?.slice(DOCKER_HOST_ALIAS.length + 1)).toMatch(ipv4);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("launches without awaiting a background probe that later launches share", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const release = yield* Deferred.make<void>();
        const hostGateway = yield* makeHostGateway;
        const spawner = makeHostGatewayProbeSpawner(delegate, probes, () => undefined, release);
        const database = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway,
          awaitHostGateway: false,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const service = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* database.prepare(image);
        const launchExit = (runtime: typeof service, instanceId: string) =>
          runtime.launchCommand({
            image,
            stackId: "e".repeat(64),
            instanceId,
            env: {},
            args: ["-e", "process.exit(0)"],
          });

        const early = yield* launchExit(database, "host-alias-background");
        expect(yield* inspectExtraHosts(early.id)).toContain(`${DOCKER_HOST_ALIAS}:host-gateway`);
        const waiting = yield* launchExit(service, "host-alias-awaiting").pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        const later = yield* Fiber.join(waiting);

        const aliases = (yield* inspectExtraHosts(later.id)).filter((entry) =>
          entry.startsWith(`${DOCKER_HOST_ALIAS}:`),
        );
        expect(aliases).toHaveLength(1);
        expect(aliases[0]?.slice(DOCKER_HOST_ALIAS.length + 1)).toMatch(ipv4);
        expect(yield* Ref.get(probes)).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("maps the host alias to the IPv4 gateway listed after an IPv6 one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(
              delegate,
              yield* Ref.make(0),
              () =>
                `console.log("fdc4:f303:9324::254\\t${DOCKER_HOST_ALIAS}\\n192.168.65.254\\t${DOCKER_HOST_ALIAS}")`,
            ),
          ),
        );
        yield* runtime.prepare(image);
        const process = yield* runtime.launchCommand({
          image,
          stackId: "e".repeat(64),
          instanceId: "host-alias-dual-stack",
          env: {},
          args: ["-e", "process.exit(0)"],
        });
        expect(yield* process.exitCode).toBe(0);
        expect(yield* inspectExtraHosts(process.id)).toContain(
          `${DOCKER_HOST_ALIAS}:192.168.65.254`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("falls back to host-gateway without reprobing when the gateway has no IPv4 address", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(
              delegate,
              probes,
              () => `console.log("fdc4:f303:9324::254\\t${DOCKER_HOST_ALIAS}")`,
            ),
          ),
        );
        yield* runtime.prepare(image);
        for (const instanceId of ["host-alias-fallback-a", "host-alias-fallback-b"]) {
          const process = yield* runtime.launchCommand({
            image,
            stackId: "e".repeat(64),
            instanceId,
            env: {},
            args: ["-e", "process.exit(0)"],
          });
          expect(yield* process.exitCode).toBe(0);
          expect(yield* inspectExtraHosts(process.id)).toContain(
            `${DOCKER_HOST_ALIAS}:host-gateway`,
          );
        }
        expect(yield* Ref.get(probes)).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retries a probe whose image lacks cat before launching", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(delegate, probes, (attempt) =>
              attempt === 1
                ? `console.error('exec: "cat": executable file not found in $PATH'); process.exit(127)`
                : undefined,
            ),
          ),
        );
        yield* runtime.prepare(image);
        const launchExit = (instanceId: string) =>
          runtime.launchCommand({
            image,
            stackId: "e".repeat(64),
            instanceId,
            env: {},
            args: ["-e", "process.exit(0)"],
          });
        const launched = yield* launchExit("host-alias-retried-probe");
        const aliases = (yield* inspectExtraHosts(launched.id)).filter((entry) =>
          entry.startsWith(`${DOCKER_HOST_ALIAS}:`),
        );
        expect(aliases).toHaveLength(1);
        expect(aliases[0]?.slice(DOCKER_HOST_ALIAS.length + 1)).toMatch(ipv4);
        expect(yield* Ref.get(probes)).toBe(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("maps the host alias to the engine's own host address when it rejects host-gateway", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(delegate, probes, (attempt) =>
              attempt === 1 ? hostGatewayRejectionScript : engineHostsScript,
            ),
          ),
        );
        yield* runtime.prepare(image);
        const process = yield* runtime.launchCommand({
          image,
          stackId: "e".repeat(64),
          instanceId: "host-alias-engine-host",
          env: {},
          args: ["-e", "process.exit(0)"],
        });
        expect(yield* process.exitCode).toBe(0);
        expect(yield* inspectExtraHosts(process.id)).toContain(`${DOCKER_HOST_ALIAS}:10.88.0.1`);
        expect(yield* Ref.get(probes)).toBe(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retries the engine host probe after it fails transiently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(delegate, probes, (attempt) =>
              attempt === 2
                ? `console.error("daemon busy"); process.exit(1)`
                : attempt === 4
                  ? engineHostsScript
                  : hostGatewayRejectionScript,
            ),
          ),
        );
        yield* runtime.prepare(image);
        const process = yield* runtime.launchCommand({
          image,
          stackId: "e".repeat(64),
          instanceId: "host-alias-engine-host-retry",
          env: {},
          args: ["-e", "process.exit(0)"],
        });
        expect(yield* process.exitCode).toBe(0);
        expect(yield* inspectExtraHosts(process.id)).toContain(`${DOCKER_HOST_ALIAS}:10.88.0.1`);
        expect(yield* Ref.get(probes)).toBe(4);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails launches actionably when an engine rejecting host-gateway maps no IPv4 host", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probes = yield* Ref.make(0);
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
        hostGateway: yield* makeHostGateway,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeHostGatewayProbeSpawner(delegate, probes, (attempt) =>
            attempt === 1
              ? hostGatewayRejectionScript
              : `console.log("127.0.0.1\\tlocalhost\\n::1\\thost.containers.internal")`,
          ),
        ),
      );
      yield* runtime.prepare(image);
      for (const instanceId of ["host-alias-unsupported-a", "host-alias-unsupported-b"]) {
        const failure = yield* Effect.scoped(
          runtime.launchCommand({
            image,
            stackId: "e".repeat(64),
            instanceId,
            env: {},
            args: ["-e", "process.exit(0)"],
          }),
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("ContainerError");
        expect(failure.message).toContain(
          "rejects host-gateway in --add-host and maps no IPv4 address",
        );
      }
      expect(yield* Ref.get(probes)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("recreates an unawaited launch the engine rejects for host-gateway", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const probes = yield* Ref.make(0);
        const database = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
          hostGateway: yield* makeHostGateway,
          awaitHostGateway: false,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeHostGatewayProbeSpawner(
              makeHostGatewayRejectingCreateSpawner(delegate),
              probes,
              (attempt) => (attempt === 1 ? hostGatewayRejectionScript : engineHostsScript),
            ),
          ),
        );
        yield* database.prepare(image);
        const process = yield* database.launchCommand({
          image,
          stackId: "e".repeat(64),
          instanceId: "host-alias-recreated",
          env: {},
          args: ["-e", "process.exit(0)"],
        });
        expect(yield* process.exitCode).toBe(0);
        expect(yield* inspectExtraHosts(process.id)).toContain(`${DOCKER_HOST_ALIAS}:10.88.0.1`);
        expect(yield* Ref.get(probes)).toBe(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("names and labels a service container for compose-style grouping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        });
        yield* runtime.prepare(image);
        const process = yield* runtime.launch({
          image,
          stackId: "9".repeat(64),
          instanceId: "naming-service",
          project: "My Cool App",
          service: "auth",
          env: {},
          args: ["-e", stoppableIdleScript],
        });
        expect(process.id).toMatch(/^supabase-My-Cool-App-auth-[0-9a-f]{12}$/u);
        const labels = yield* inspectLabels(process.id);
        expect(labels["com.supabase.service"]).toBe("auth");
        expect(labels["com.docker.compose.project"]).toBe(`supabase-my-cool-app-${"9".repeat(12)}`);
        expect(labels["com.docker.compose.service"]).toBe("auth");
        expect(labels["com.docker.compose.oneoff"]).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("marks a one-shot container's name and compose labels as a task", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        });
        yield* runtime.prepare(image);
        const process = yield* runtime.launchCommand({
          image,
          stackId: "9".repeat(64),
          instanceId: "naming-task",
          project: "My Cool App",
          service: "auth",
          env: {},
          args: ["-e", "process.exit(0)"],
        });
        expect(process.id).toMatch(/^supabase-My-Cool-App-auth-task-[0-9a-f]{12}$/u);
        const labels = yield* inspectLabels(process.id);
        expect(labels["com.supabase.service"]).toBe("auth");
        expect(labels["com.docker.compose.service"]).toBe("auth");
        expect(labels["com.docker.compose.oneoff"]).toBe("True");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("labels a created container with the configured test run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        });
        yield* runtime.prepare(image);
        const crypto = yield* Crypto.Crypto;
        const testRunId = `container-test-run-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
        const process = yield* runtime
          .launch({
            image,
            stackId: "container-test-run",
            instanceId: "labels-test-run",
            env: {},
            args: ["-e", stoppableIdleScript],
          })
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord({ SUPABASE_STACK_TEST_RUN: testRunId }),
              ),
            ),
          );
        const labels = yield* inspectLabels(process.id);
        expect(labels["com.supabase.stack-test-run"]).toBe(testRunId);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "publishes two private ports and keeps the second service alive after the first stops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({
            claims: noContainerClaims,
            target: dockerTarget,
            root: ".",
          });
          yield* runtime.prepare(image);
          const launch = (instanceId: string, marker: string) =>
            runtime.launch({
              image,
              stackId: "b".repeat(64),
              instanceId,
              env: {},
              ports: [8080],
              args: [
                "-e",
                `process.on('SIGTERM', () => process.exit(0)); Bun.serve({ hostname: '0.0.0.0', port: 8080, fetch() { return new Response(${JSON.stringify(marker)}) } }); console.log('ready')`,
              ],
            });
          const first = yield* launch("http-one", "one");
          const firstReady = yield* ready(first);
          const second = yield* launch("http-two", "two");
          const secondReady = yield* ready(second);
          expect(first.ports[8080]).toBeDefined();
          expect(second.ports[8080]).toBeDefined();
          expect(first.ports[8080]).not.toBe(second.ports[8080]);
          expect(yield* get(first.ports[8080])).toBe("one");
          expect(yield* get(second.ports[8080])).toBe("two");
          yield* first.stop;
          yield* first.remove;
          expect(yield* get(second.ports[8080])).toBe("two");
          yield* second.stop;
          yield* second.remove;
          yield* Fiber.interrupt(firstReady);
          yield* Fiber.interrupt(secondReady);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stops a container with its configured stop signal", () =>
    Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      });
      yield* runtime.prepare(image);
      const process = yield* runtime.launch({
        image,
        stackId: "r".repeat(64),
        instanceId: "stop-signal",
        env: {},
        args: [
          "-e",
          "process.on('SIGINT', () => process.exit(3)); setInterval(() => {}, 1000); console.log('ready')",
        ],
        stopSignal: "SIGINT",
        stopGraceSeconds: 20,
      });
      const logs = yield* ready(process);

      yield* process.stop;
      expect(yield* process.exitCode).toBe(3);

      yield* process.remove;
      yield* Fiber.interrupt(logs);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("waits until a discarded container stops before returning", () =>
    Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      });
      yield* runtime.prepare(image);
      const process = yield* runtime.launch({
        image,
        stackId: "f".repeat(64),
        instanceId: "discard-waits-for-stop",
        env: {},
        args: [
          "-e",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2000)); setInterval(() => {}, 1000); console.log('ready')",
        ],
      });
      const logs = yield* ready(process);

      yield* process.discard;
      expect(yield* running(process.id)).toBe(false);
      expect(yield* exists(process.id)).toBe(true);

      yield* process.remove;
      expect(yield* exists(process.id)).toBe(false);
      yield* Fiber.interrupt(logs);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("returns cleanup authority when container start fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        });
        yield* runtime.prepare(image);
        const result = yield* runtime
          .launch({
            image,
            stackId: "c".repeat(64),
            instanceId: "invalid-entrypoint",
            env: {},
            entrypoint: "/definitely/missing/entrypoint",
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result))
          return yield* Effect.die("invalid entrypoint unexpectedly started");
        const failure = Cause.findErrorOption(result.cause);
        expect(Option.isSome(failure) && failure.value instanceof ContainerLaunchError).toBe(true);
        if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
          return yield* Effect.die("launch failure did not retain cleanup authority");
        const id = failure.value.process.id;
        yield* failure.value.process.remove;
        expect(yield* exists(id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps exit observation shared after a caller cancels its wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        });
        yield* runtime.prepare(image);
        const process = yield* runtime.launch({
          image,
          stackId: "d".repeat(64),
          instanceId: "cancelled-waiter",
          env: {},
          args: [
            "-e",
            "process.on('SIGTERM', () => process.exit(23)); setInterval(() => {}, 1000); console.log('ready')",
          ],
        });
        const logs = yield* ready(process);
        const waiter = yield* process.exitCode.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(waiter);
        expect(Exit.hasInterrupts(yield* Fiber.await(waiter))).toBe(true);
        yield* process.stop;
        expect(yield* process.exitCode).toBe(23);
        yield* Fiber.interrupt(logs);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("releases a log follower that exits while its container keeps running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const released = yield* Deferred.make<void>();
        const runtime = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target: dockerTarget,
          root: ".",
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeLogFollowerSpawner(
              delegate,
              released,
              "console.error('injected log stream failure'); process.exit(1)",
            ),
          ),
        );
        yield* runtime.prepare(image);
        const process = yield* runtime.launch({
          image,
          stackId: "s".repeat(64),
          instanceId: "dropped-log-follower",
          env: {},
          args: ["-e", "setInterval(() => {}, 1000)"],
        });
        yield* Deferred.await(released).pipe(Effect.timeout("10 seconds"));
        expect(
          yield* process.stderr.pipe(
            Stream.decodeText,
            Stream.mkString,
            Effect.timeout("10 seconds"),
          ),
        ).toContain("injected log stream failure");
        expect(yield* running(process.id)).toBe(true);
        yield* process.discard;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("releases a still running log follower when its launch scope closes", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const released = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({
            claims: noContainerClaims,
            target: dockerTarget,
            root: ".",
          }).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              makeLogFollowerSpawner(delegate, released, "setInterval(() => {}, 1000)"),
            ),
          );
          yield* runtime.prepare(image);
          const process = yield* runtime.launch({
            image,
            stackId: "t".repeat(64),
            instanceId: "live-log-follower",
            env: {},
            args: ["-e", "setInterval(() => {}, 1000)"],
          });
          expect(yield* Deferred.isDone(released)).toBe(false);
          yield* process.discard;
        }),
      );
      expect(yield* Deferred.isDone(released)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("treats an externally removed container as already stopped", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `externally-removed-${token}`;
      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeContainerRuntime({
              claims: noContainerClaims,
              target: dockerTarget,
              root: ".",
            });
            yield* runtime.prepare(image);
            const process = yield* runtime.launch({
              image,
              stackId: "x".repeat(64),
              instanceId,
              env: {},
              args: ["-e", stoppableIdleScript],
            });
            yield* removeExternally(process.id);
            yield* process.stop;
            yield* process.remove;
            expect(yield* exists(process.id)).toBe(false);
          }),
        ),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("confirms absence after the remove client loses its result", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `lost-remove-result-${token}`;
      const lostResult = yield* Ref.make(false);
      const spawner = makeLostRemoveResultSpawner(delegate, lostResult);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "k".repeat(64),
                instanceId,
                env: {},
                args: ["-e", stoppableIdleScript],
              });
              yield* process.stop;
              yield* process.remove;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(lostResult)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains a remove failure for a still-present non-removing container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-remove-${token}`;
      const failed = yield* Ref.make(false);
      const spawner = makeRemoveFailureSpawner(delegate, failed);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "l".repeat(64),
                instanceId,
                env: {},
                args: ["-e", stoppableIdleScript],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult))
                expect(Cause.pretty(removeResult.cause)).toContain("injected remove failure");
              expect(yield* exists(process.id)).toBe(true);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(failed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains both remove and reconciliation failures", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-reconciliation-${token}`;
      const failed = yield* Ref.make(false);
      const failProbe = yield* Ref.make(true);
      const spawner = makeRemoveFailureSpawner(delegate, failed, failProbe);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "m".repeat(64),
                instanceId,
                env: {},
                args: ["-e", stoppableIdleScript],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult)) {
                const diagnostic = Cause.pretty(removeResult.cause);
                expect(diagnostic).toContain("injected remove failure");
                expect(diagnostic).toContain("injected reconciliation failure");
              }
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(failed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "waits for a real removal observed as removing",
    () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const token = yield* crypto.randomUUIDv4;
        const instanceId = `pending-remove-${token}`;
        const pendingProbes = yield* Ref.make(2);
        const lostResult = yield* Ref.make(false);
        const spawner = makePendingRemoveSpawner(delegate, pendingProbes, lostResult);
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const runtime = yield* makeContainerRuntime({
                  claims: noContainerClaims,
                  target: dockerTarget,
                  root: ".",
                });
                yield* runtime.prepare(image);
                const process = yield* runtime.launch({
                  image,
                  stackId: "n".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", stoppableIdleScript],
                });
                yield* process.stop;
                yield* process.remove;
              }),
            ).pipe(
              Effect.exit,
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
            expect(yield* Ref.get(lostResult)).toBe(true);
            expect(yield* Ref.get(pendingProbes)).toBe(0);
            expect(Exit.isSuccess(result)).toBe(true);
            expect(yield* idsByInstance(instanceId)).toHaveLength(0);
          }),
          removeByInstance(instanceId).pipe(Effect.orDie),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );

  it.live("retains the remove failure when removing never reaches absence", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `stalled-remove-${token}`;
      const pendingProbes = yield* Ref.make(Number.POSITIVE_INFINITY);
      const lostResult = yield* Ref.make(false);
      const spawner = makePendingRemoveSpawner(delegate, pendingProbes, lostResult);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "p".repeat(64),
                instanceId,
                env: {},
                args: ["-e", stoppableIdleScript],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult)) {
                const diagnostic = Cause.pretty(removeResult.cause);
                expect(diagnostic).toContain("Engine exited with 73");
                expect(diagnostic).toContain("TimeoutError");
              }
              expect(yield* exists(process.id)).toBe(false);
              yield* Ref.set(pendingProbes, 0);
              yield* process.remove;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(lostResult)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves caller interruption and reconciles during scope close", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `interrupted-remove-${token}`;
      const completed = yield* Deferred.make<void>();
      const consumed = yield* Ref.make(false);
      const spawner = makeInterruptedRemoveSpawner(delegate, consumed, completed);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "o".repeat(64),
                instanceId,
                env: {},
                args: ["-e", stoppableIdleScript],
              });
              yield* process.stop;
              const remover = yield* process.remove.pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Deferred.await(completed);
              expect(yield* exists(process.id)).toBe(false);
              yield* Fiber.interrupt(remover);
              expect(Exit.hasInterrupts(yield* Fiber.await(remover))).toBe(true);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(consumed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a scope failure when stop fails and leaves cleanup authority", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const failStop = yield* Ref.make(true);
      const processRef = yield* Ref.make<Option.Option<ContainerProcess>>(Option.none());
      const spawner = makeStopFailureSpawner(delegate, failStop);
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-stop-${token}`;
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "f".repeat(64),
                instanceId,
                env: {},
                args: [
                  "-e",
                  "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)",
                ],
              });
              yield* Ref.set(processRef, Option.some(process));
              const logs = yield* ready(process);
              yield* Fiber.interrupt(logs);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("injected stop failure");
          const process = yield* Ref.get(processRef).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("launch did not retain cleanup authority"),
                onSome: Effect.succeed,
              }),
            ),
          );
          expect(yield* running(process.id)).toBe(true);
          yield* Ref.set(failStop, false);
          yield* process.stop;
          yield* process.remove;
          expect(yield* exists(process.id)).toBe(false);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when create reports failure after creating a container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-create-after-commit-${token}`;
      const created = yield* Ref.make(false);
      const spawner = makeCreateFailureSpawner(delegate, created, true);
      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeContainerRuntime({
              claims: noContainerClaims,
              target: dockerTarget,
              root: ".",
            });
            yield* runtime.prepare(image);
            const result = yield* runtime
              .launch({
                image,
                stackId: "g".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              })
              .pipe(Effect.exit);
            if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
            const failure = Cause.findErrorOption(result.cause);
            if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
              return yield* Effect.die("launch failure did not retain cleanup authority");
            expect(failure.value.failure.message).toContain("injected create failure");
            expect(failure.value.failure.message).toContain("container name supabase-");
            expect(yield* Ref.get(created)).toBe(true);
            expect(yield* idsByInstance(instanceId)).toHaveLength(1);
            yield* failure.value.process.stop;
            yield* failure.value.process.remove;
            expect(yield* idsByInstance(instanceId)).toHaveLength(0);
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when create fails without creating a container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-create-empty-${token}`;
      const created = yield* Ref.make(false);
      const spawner = makeCreateFailureSpawner(delegate, created, false);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({
                claims: noContainerClaims,
                target: dockerTarget,
                root: ".",
              });
              yield* runtime.prepare(image);
              return yield* runtime
                .launch({
                  image,
                  stackId: "q".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
                .pipe(Effect.exit);
            }),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
          const failure = Cause.findErrorOption(result.cause);
          if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
            return yield* Effect.die("launch failure did not retain cleanup authority");
          expect(failure.value.failure.message).toContain("injected create failure");
          expect(yield* Ref.get(created)).toBe(false);
          yield* failure.value.process.stop;
          yield* failure.value.process.remove;
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when create is cancelled before its result is exposed", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `pending-create-${token}`;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const present = yield* Ref.make(false);
      const spawner = makePendingCreateSpawner(delegate, started, release, present);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({
            claims: noContainerClaims,
            target: dockerTarget,
            root: ".",
          });
          yield* runtime.prepare(image);
          const launch = yield* runtime
            .launch({
              image,
              stackId: "h".repeat(64),
              instanceId,
              env: {},
              args: ["-e", "setInterval(() => {}, 1000)"],
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          yield* Effect.sync(() => launch.interruptUnsafe());
          yield* Ref.set(present, true);
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.await(launch);
          expect(Exit.isFailure(result)).toBe(true);
          expect(Exit.hasInterrupts(result)).toBe(true);
          return result;
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(present)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds a hung docker create and removes the container it may still create", () =>
    Effect.gen(function* () {
      const engine = yield* makeHangingCreateSpawner();
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      }).pipe(Effect.provide(engine.layer));
      const launch = yield* Effect.scoped(
        runtime.launch({ image, stackId: "i".repeat(64), instanceId: "hung-create", env: {} }),
      ).pipe(Effect.provide(engine.layer), Effect.exit, Effect.forkChild);
      yield* Deferred.await(engine.createStarted);
      yield* TestClock.adjust("2 minutes");
      const result = yield* Fiber.join(launch);
      expect(Exit.isFailure(result)).toBe(true);
      const failure = Exit.isFailure(result)
        ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
        : undefined;
      expect(failure instanceof ContainerLaunchError).toBe(true);
      expect(
        failure instanceof ContainerLaunchError ? failure.failure.message : undefined,
      ).toContain("did not respond");
      expect(engine.commands).toContainEqual(["rm", "--force", engine.createdName()]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the container a hung docker create may still create when interrupted", () =>
    Effect.gen(function* () {
      const engine = yield* makeHangingCreateSpawner();
      const runtime = yield* makeContainerRuntime({
        claims: noContainerClaims,
        target: dockerTarget,
        root: ".",
      }).pipe(Effect.provide(engine.layer));
      const launch = yield* Effect.scoped(
        runtime.launch({ image, stackId: "i".repeat(64), instanceId: "interrupted", env: {} }),
      ).pipe(Effect.provide(engine.layer), Effect.forkChild);
      yield* Deferred.await(engine.createStarted);
      yield* Fiber.interrupt(launch);
      expect(Exit.hasInterrupts(yield* Fiber.await(launch))).toBe(true);
      expect(engine.createdName()).toMatch(/^supabase-/u);
      expect(engine.commands).toContainEqual(["rm", "--force", engine.createdName()]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "resolveEngineTarget pins the context resolved at startup by name, unaffected by a later context switch",
    () =>
      Effect.gen(function* () {
        const contextCalls: Array<ReadonlyArray<string>> = [];
        let activeContext = "alpha";
        const handle = (exitCode: number, stdout = "") =>
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.succeed(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
            return Effect.die("Unexpected command");
          if (command.args[0] === "context" && command.args[1] === "show") {
            contextCalls.push(command.args);
            return Effect.succeed(handle(0, `${activeContext}\n`));
          }
          // Identity is resolved through the same pinned context, so "info" arrives prefixed with
          // the `--context <name>` pin this very call resolved, by name, not by endpoint: pinning
          // by name (rather than an inspected endpoint) is what keeps a TLS context's own
          // certificate material intact for this and every later invocation.
          if (command.args[0] === "--context" && command.args[2] === "info")
            return Effect.succeed(handle(0, `daemon-at-${command.args[1]}`));
          return Effect.die(`Unexpected docker command: ${command.args.join(" ")}`);
        });
        const target = yield* resolveEngineTarget(spawner);
        // Simulates `docker context use beta` run elsewhere, after this target was resolved.
        activeContext = "beta";
        expect(contextCalls).toHaveLength(1);
        expect(target.argv).toEqual(["--context", "alpha"]);
        expect(target.daemonId).toBe("daemon-at-alpha");
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        ),
      ),
  );

  it.live(
    "classifies a real connection refusal to the engine as permanently unavailable (F3)",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // A real connection attempt, not a mocked one: nothing listens on this loopback port, so
        // the docker CLI's own refusal is what `errorFor` classifies, at its one true source.
        const failure = yield* resolveEngineTarget(spawner).pipe(Effect.flip);
        expect(
          engineUnreachable(failure),
          "a real daemon connection refusal classifies as engine-unavailable",
        ).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({ DOCKER_HOST: "tcp://127.0.0.1:1" }),
            ),
          ),
        ),
      ),
  );

  it.live("classifies a real missing engine binary as permanently unavailable (F3)", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      // A directory deliberately containing no `docker` binary, real `PATH` lookup included: the
      // engine's own spawn failure, not a stubbed `ChildProcessSpawner`, is what `errorFor`
      // classifies.
      const emptyBinDir = yield* fs.makeTempDirectoryScoped({ prefix: "engine-missing-bin-" });
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the spawned child inherits PATH; this is not application config.
      const originalPath = process.env.PATH;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
          process.env.PATH = emptyBinDir;
        }),
        () =>
          Effect.sync(() => {
            // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
            process.env.PATH = originalPath;
          }),
      );
      const failure = yield* resolveEngineTarget(spawner).pipe(Effect.flip);
      expect(
        engineUnreachable(failure),
        "a real spawn ENOENT for the missing docker binary classifies as engine-unavailable",
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      ),
    ),
  );

  it.live(
    "keeps helper creation, runtime launches, password reconcile and reconcile pinned to the context an owner resolved at startup, despite a later context switch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "engine-target-pin-" });
        const commands: Array<ReadonlyArray<string>> = [];
        let activeContext = "alpha";
        const handle = (exitCode: number, stdout = "") =>
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: stdout === "" ? Stream.empty : Stream.succeed(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        // A permissive fake: every engine call this test's consumers make succeeds, so the only
        // thing under test is the argv each one is actually invoked with.
        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
            return Effect.die("Unexpected command");
          commands.push(command.args);
          if (command.args[0] === "context" && command.args[1] === "show")
            return Effect.succeed(handle(0, `${activeContext}\n`));
          // Every other call carries the `--context <name>` pin this test's resolution produced.
          const unpinned = command.args.slice(2);
          if (unpinned[0] === "info") return Effect.succeed(handle(0, "fake-daemon-id"));
          if (unpinned[0] === "version") return Effect.succeed(handle(0, "27.0.0|27.0.0"));
          if (unpinned[0] === "inspect")
            return Effect.succeed(handle(0, '{"Ports":{},"Status":"running","ExitCode":0}'));
          if (unpinned[0] === "run") return Effect.succeed(handle(0, "abcdef012345"));
          return Effect.succeed(handle(0));
        });

        // Resolved once, as an owner's own startup would.
        const target = yield* resolveEngineTarget(spawner);
        expect(target.argv).toEqual(["--context", "alpha"]);
        // Simulates `docker context use beta` run elsewhere, after this target was resolved.
        activeContext = "beta";
        // Only the resolution above may run unpinned; every consumer exercised below must carry
        // the context it pinned, regardless of the later switch.
        commands.length = 0;

        const container = yield* makeContainerRuntime({
          claims: noContainerClaims,
          target,
          root,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        // Runtime launches.
        yield* container
          .prepare(image)
          .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* Effect.scoped(
          container.launchCommand({
            image,
            stackId: "f".repeat(64),
            instanceId: "engine-target-pin-launch",
            env: {},
            args: ["-e", "process.exit(0)"],
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        // Helper creation, sharing the same container runtime a real stack would.
        const storage = yield* makeDockerDatabaseStorage({
          claims: noContainerClaims,
          runtime: "docker",
          target,
          stackId: "engine-target-pin",
          instanceId: "database",
          instanceRoot: root,
          root,
          cacheRoot: path.join(root, "cache"),
          fs,
          path,
          crypto,
          container,
          spawner,
        });
        yield* storage.prepare("17");

        // Password reconcile: the consumer F2 found spawning the engine unpinned.
        yield* reconcileContainerPassword(
          target,
          "password-reconcile-container",
          Redacted.make("engine-target-pin-password"),
          spawner,
        );

        // Reconcile: an orphaned claim from a crashed owner, removed through the same target.
        const orphanId = "orphan00000000000000000000000000001";
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root: path.join(root, "state") })),
          StackNamespace.Service,
        );
        const saved = {
          id: "engine-target-pin",
          runtime: "docker" as const,
          identity: { projectRoot: root, branchContext: "main", stackName: "engine-target-pin" },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        yield* state.claim(saved.id, {
          kind: "container",
          id: orphanId,
          daemonId: target.daemonId,
        });
        yield* Owner.sweepContainers(state, saved, root, target).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(yield* state.readClaims(saved.id)).toEqual([]);

        // Every call these consumers made, after the target was resolved, carries the context
        // pinned at startup: asserted of the whole list, not merely of a filtered subset, so a
        // consumer that forgets the pin (as the password reconcile once did) fails this test
        // instead of being silently excluded from it.
        expect(commands.length).toBeGreaterThan(0);
        for (const args of commands) expect(args.slice(0, 2)).toEqual(["--context", "alpha"]);
        // Each consumer is actually exercised, not vacuously skipped.
        expect(commands.some((args) => args.includes("pull"))).toBe(true);
        expect(commands.some((args) => args.includes("version"))).toBe(true);
        expect(commands.some((args) => args.includes("password-reconcile-container"))).toBe(true);
        expect(commands.some((args) => args.includes("rm") && args.includes(orphanId))).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        ),
      ),
  );
});

const repoDigest = (spawner: ChildProcessSpawnerService["Service"], image: string) =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        ["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", image],
        { stdin: "ignore" },
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all([
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ]);
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker image inspect exited with ${String(code)}`,
        cause: stderr.trim(),
      });
    const digest = stdout
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.includes("@sha256:"));
    if (digest === undefined)
      return yield* new ContainerTestError({
        message: `docker image inspect returned no repository digest for ${image}`,
      });
    return digest;
  });

const makePullFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  pullAttempted: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "pull"
    )
      return Effect.gen(function* () {
        yield* Ref.set(pullAttempted, true);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('pull rejected by cached-image regression'); process.exit(73)"],
            { stdin: "ignore" },
          ),
        );
      });
    return delegate.spawn(command);
  });

const hostGatewayRejectionScript = `console.error(${JSON.stringify(
  'Error response from daemon: invalid IP address in add-host: "host-gateway"',
)}); process.exit(125)`;

const engineHostsScript = `console.log("10.88.0.1\\thost.docker.internal")`;

/** Rejects a `docker create` that maps the host alias to `host-gateway`. */
const makeHostGatewayRejectingCreateSpawner = (delegate: ChildProcessSpawnerService["Service"]) =>
  ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) &&
    command.command === "docker" &&
    command.args[0] === "create" &&
    command.args.includes(`${DOCKER_HOST_ALIAS}:host-gateway`)
      ? delegate.spawn(
          ChildProcess.make(process.execPath, ["-e", hostGatewayRejectionScript], {
            stdin: "ignore",
          }),
        )
      : delegate.spawn(command),
  );

/**
 * Replaces a host-gateway probe with the script `fake` returns for its attempt, if any; a probe
 * spawns only once `release`, when given, completes.
 */
const makeHostGatewayProbeSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  probes: Ref.Ref<number>,
  fake: (attempt: number) => string | undefined,
  release?: Deferred.Deferred<void>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      !ChildProcess.isStandardCommand(command) ||
      command.command !== "docker" ||
      command.args[0] !== "run" ||
      !command.args.includes("/etc/hosts")
    )
      return delegate.spawn(command);
    return Effect.gen(function* () {
      const script = fake(yield* Ref.updateAndGet(probes, (count) => count + 1));
      if (release !== undefined) yield* Deferred.await(release);
      return yield* delegate.spawn(
        script === undefined
          ? command
          : ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }),
      );
    });
  });

const makeStopFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  failStop: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "stop"
    ) {
      return Effect.gen(function* () {
        if (!(yield* Ref.get(failStop))) return yield* delegate.spawn(command);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected stop failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    return delegate.spawn(command);
  });

const makeLogFollowerSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  released: Deferred.Deferred<void>,
  script: string,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "logs"
    )
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        return yield* delegate.spawn(
          ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }),
        );
      });
    return delegate.spawn(command);
  });

const makeLostRemoveResultSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  lostResult: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(lostResult)) return yield* delegate.spawn(command);
        yield* Ref.set(lostResult, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(Effect.as(ChildProcessSpawner.ExitCode(73))),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeRemoveFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  failed: Ref.Ref<boolean>,
  failProbe?: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      failProbe !== undefined &&
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      // Excludes the host-gateway probe's own throwaway "-task-" container, created and awaited
      // absent during `launch`, before this test's own instance container ever reaches `remove`.
      command.args.some((arg) => arg.startsWith("name=^/?") && !arg.includes("-task-"))
    ) {
      return Effect.gen(function* () {
        if (!(yield* Ref.get(failProbe))) return yield* delegate.spawn(command);
        yield* Ref.set(failProbe, false);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected reconciliation failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(failed)) return yield* delegate.spawn(command);
        yield* Ref.set(failed, true);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected remove failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    return delegate.spawn(command);
  });

const makePendingRemoveSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  pendingProbes: Ref.Ref<number>,
  lostResult: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      // Excludes the host-gateway probe's own throwaway "-task-" container, created and awaited
      // absent during `launch`, before this test's own instance container ever reaches `remove`.
      command.args.some((arg) => arg.startsWith("name=^/?") && !arg.includes("-task-"))
    ) {
      return Effect.gen(function* () {
        const remaining = yield* Ref.get(pendingProbes);
        if (remaining === 0) return yield* delegate.spawn(command);
        yield* Ref.set(pendingProbes, remaining - 1);
        return yield* delegate.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.stdout.write('removing\\n')"], {
            stdin: "ignore",
          }),
        );
      });
    }
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(lostResult)) return yield* delegate.spawn(command);
        yield* Ref.set(lostResult, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(Effect.as(ChildProcessSpawner.ExitCode(73))),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeInterruptedRemoveSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  consumed: Ref.Ref<boolean>,
  completed: Deferred.Deferred<void>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(consumed)) return yield* delegate.spawn(command);
        yield* Ref.set(consumed, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(
            Effect.tap(() => Deferred.succeed(completed, undefined)),
            Effect.andThen(Effect.never),
          ),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeCreateFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  created: Ref.Ref<boolean>,
  createResource: boolean,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "create"
    ) {
      return Effect.gen(function* () {
        if (createResource) {
          const actual = yield* delegate.spawn(command);
          const code = yield* actual.exitCode;
          expect(Number(code)).toBe(0);
          yield* Ref.set(created, true);
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(new TextEncoder().encode("injected create failure\n")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      });
    }
    return delegate.spawn(command);
  });

const makePendingCreateSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  present: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
      return delegate.spawn(command);
    if (command.args[0] === "stop" || command.args[0] === "rm") {
      return Effect.gen(function* () {
        if (command.args[0] === "rm") yield* Ref.set(present, false);
        return successfulHandle();
      });
    }
    if (command.args[0] !== "create") return delegate.spawn(command);
    return Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      const create = Deferred.await(release);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: create.pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: create.pipe(Effect.as(false)),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  });

const successfulHandle = (stdout = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: stdout === "" ? Stream.empty : Stream.succeed(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const makeHangingCreateSpawner = Effect.fn("ContainerTest.hangingCreateSpawner")(function* () {
  const commands: string[][] = [];
  const createStarted = yield* Deferred.make<void>();
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    commands.push([...command.args]);
    if (command.args[0] === "info") return Effect.succeed(successfulHandle("fake-daemon-id"));
    if (command.args[0] !== "create") return Effect.succeed(successfulHandle());
    // The engine never answers create; the real daemon may or may not have committed it.
    return Deferred.succeed(createStarted, undefined).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
  });
  const createdName = () => {
    const args = commands.find((command) => command[0] === "create") ?? [];
    return args[args.indexOf("--name") + 1];
  };
  return {
    commands,
    createStarted,
    createdName,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
});

const ready = (process: ContainerProcess) =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<void>();
    const observer = yield* process.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((chunk) =>
        chunk === "ready" ? Deferred.succeed(signal, undefined) : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(signal);
    return observer;
  });

const exists = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* child.exitCode) === 0;
  });

const inspectLabels = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", "--format={{json .Config.Labels}}", id], {
        stdin: "ignore",
      }),
    );
    const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
    return yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(output.trim());
  });

const inspectExtraHosts = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", "--format={{json .HostConfig.ExtraHosts}}", id], {
        stdin: "ignore",
      }),
    );
    const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
      output.trim(),
    );
  });

const removeExternally = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["rm", "--force", id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const code = yield* child.exitCode;
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker rm --force exited with ${String(code)}`,
      });
  });

const idsByInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        [
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.instance=${instanceId}`,
        ],
        { stdin: "ignore" },
      ),
    );
    const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
    return output
      .split("\n")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  });

const removeByInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ids = yield* idsByInstance(instanceId);
    if (ids.length === 0) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["rm", "--force", ...ids], { stdin: "ignore" }),
    );
    const [stderr, code] = yield* Effect.all([
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ]);
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker rm exited with ${String(code)}`,
        cause: stderr.trim(),
      });
  });

const running = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", "--format={{.State.Running}}", id], {
        stdin: "ignore",
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText, Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    expect(Number(exitCode)).toBe(0);
    return output.trim() === "true";
  });

const get = (port: number | undefined, path = "/") => {
  if (port === undefined)
    return Effect.fail(new ContainerTestError({ message: "container port was not assigned" }));
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`http://127.0.0.1:${port}${path}`);
    return yield* response.text;
  }).pipe(
    Effect.mapError(
      (cause) => new ContainerTestError({ message: "container request failed", cause }),
    ),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );
};
