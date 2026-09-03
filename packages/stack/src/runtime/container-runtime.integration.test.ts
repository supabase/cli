import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { NodeServices } from "@effect/platform-node";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import { StackIdSchema } from "../public/StackId.ts";
import {
  ContainerCommandError,
  ContainerEngineProtocolError,
  makeProcessCommandRunner,
  selectContainerEngine,
  type ContainerProcessRequest,
  type ContainerCommandResult,
  type ContainerContainerSpec,
  type ContainerLogLine,
  type ContainerEngine,
  type ContainerCommandRunner,
  type ContainerNetworkSpec,
  type ContainerResource,
  type ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import { makeDockerEngine, serializeDockerCommand } from "./DockerEngine.ts";
import { makePodmanEngine, serializePodmanCommand } from "./PodmanEngine.ts";
import { makeContainerRuntime } from "./ContainerRuntime.ts";
import { RuntimeDriverError, type RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import { LogStoreError, type LogRecord, type LogStore } from "../supervisor/LogStore.ts";
import { ContainerEngineError } from "../public/Errors.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeSupervisor, type SupervisorRuntime } from "../supervisor/Supervisor.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import { deriveStackId } from "../identity/Identity.ts";

const makeControlledCommandRunner = (
  options: Omit<ContainerCommandRunner, "executable"> & { readonly executable?: string },
): ContainerCommandRunner => ({
  executable: options.executable ?? "controlled-container-engine",
  run: options.run,
  ...(options.stream === undefined ? {} : { stream: options.stream }),
});

const stackId = StackIdSchema.make("a".repeat(64));
const key: RuntimeWorkloadKey = {
  stackId,
  workloadId: "database:database",
};

const containerArtifact: ContainerArtifact = {
  kind: "container",
  image: "example/database:1",
};

const workload = (selected: PlannedWorkload["selected"] = containerArtifact): PlannedWorkload => ({
  id: key.workloadId,
  capability: key.workloadId.startsWith("functions:") ? "functions" : "database",
  dependencies: [],
  readiness: { mode: "tcp" },
  artifacts: {
    native: { kind: "native", release: "1" },
    container: containerArtifact,
  },
  selected,
});

const commandResult = (value: unknown): ContainerCommandResult => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  exitCode: 0,
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

interface FakeContainerState {
  resources: Array<ContainerResource>;
  imagePresent: boolean;
  calls: Array<string>;
  createdSpecs: Array<ContainerContainerSpec>;
  nextId: number;
  inspectImageFailure?: ContainerCommandError;
  copyFailure?: ContainerCommandError;
  waitExitCode?: number;
}

const fakeContainerEngine = (state: FakeContainerState): ContainerEngine => {
  const id = (prefix: string): string => `${prefix}-${state.nextId++}`;
  const find = (resourceId: string): ContainerResource | undefined =>
    state.resources.find((resource) => resource.id === resourceId);
  return {
    kind: "docker",
    executable: "controlled-container-engine",
    preflight: Effect.succeed({ host: "host.docker.internal" }),
    probe: Effect.void,
    inspectImage: () =>
      state.inspectImageFailure !== undefined
        ? Effect.fail(state.inspectImageFailure)
        : Effect.sync(() => {
            state.calls.push("inspect-image");
            return { present: state.imagePresent };
          }),
    pullImage: () =>
      Effect.sync(() => {
        state.calls.push("pull-image");
        state.imagePresent = true;
      }),
    listResources: () =>
      Effect.sync(() => {
        state.calls.push("list-resources");
        return [...state.resources];
      }),
    createNetwork: (spec: ContainerNetworkSpec) =>
      Effect.sync(() => {
        state.calls.push("create-network");
        const resource: ContainerResource = {
          id: id("network"),
          name: spec.name,
          kind: "network",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeNetwork: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`remove-network:${resourceId}`);
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
    createVolume: (spec: ContainerVolumeSpec) =>
      Effect.sync(() => {
        state.calls.push(`create-volume:${spec.name}`);
        const resource: ContainerResource = {
          id: id("volume"),
          name: spec.name,
          kind: "volume",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeVolume: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`remove-volume:${resourceId}`);
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
    createContainer: (spec: ContainerContainerSpec) =>
      Effect.sync(() => {
        state.calls.push("create-container");
        state.createdSpecs.push(spec);
        const resource: ContainerResource = {
          id: id("container"),
          name: spec.name,
          kind: spec.role,
          labels: spec.labels,
          state: "created",
        };
        state.resources.push(resource);
        return resource;
      }),
    copyToContainer: (resourceId: string, source: string, destination: string) =>
      state.copyFailure !== undefined
        ? Effect.fail(state.copyFailure)
        : Effect.sync(() => {
            state.calls.push(`copy:${resourceId}:${source}:${destination}`);
          }),
    startContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`start:${resourceId}`);
        const resource = find(resourceId);
        if (resource !== undefined)
          state.resources = state.resources.map((entry) =>
            entry.id === resourceId ? { ...entry, state: "running" } : entry,
          );
      }),
    waitContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`wait:${resourceId}`);
        return state.waitExitCode ?? 0;
      }),
    stopContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`stop:${resourceId}`);
        const resource = find(resourceId);
        if (resource !== undefined)
          state.resources = state.resources.map((entry) =>
            entry.id === resourceId ? { ...entry, state: "stopped" } : entry,
          );
      }),
    removeContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`remove:${resourceId}`);
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
  };
};

const memoryLogStore = (records: LogRecord[]): LogStore => ({
  path: "memory://container-logs",
  append: (record) =>
    Effect.sync(() => ({
      cursor: { opaque: `v1_${records.length + 1}` },
      timestamp: "2026-01-01T00:00:00.000Z",
      ...record,
    })).pipe(Effect.tap((entry) => Effect.sync(() => records.push(entry)))),
  read: () => Effect.succeed([]),
});

describe("container runtime", () => {
  it.live("executes the exact command argv through a bounded process boundary", () =>
    Effect.gen(function* () {
      const runner = yield* makeProcessCommandRunner({
        executable: process.execPath,
        baseArgs: [
          "-e",
          "if (process.argv[1] !== 'version' || process.argv[2] !== '--format' || process.argv[3] !== '{{json .}}') process.exit(9); process.stdout.write(JSON.stringify({ok:true}))",
        ],
      });
      const result = yield* runner.run({ args: ["version", "--format", "{{json .}}"] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('{"ok":true}');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("interrupts an owned Docker log follower subprocess", () =>
    Effect.gen(function* () {
      const firstChunk = yield* Deferred.make<void>();
      const runner = yield* makeProcessCommandRunner({
        executable: process.execPath,
        baseArgs: ["-e", "process.stdout.write('follower-line\\n'); setInterval(() => {}, 1000)"],
      });
      const follower = yield* runner.stream!({
        args: ["logs", "--follow", "--tail", "0", "container-id"],
      }).pipe(
        Stream.runForEach(() => Deferred.succeed(firstChunk, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(follower);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("selects only the explicitly requested engine without probing", () =>
    Effect.gen(function* () {
      const dockerCalls: string[] = [];
      const podmanCalls: string[] = [];
      const docker = makeDockerEngine({
        runner: makeControlledCommandRunner({
          run: (request) =>
            Effect.sync(() => {
              dockerCalls.push(request.args[0] ?? "");
              return commandResult({ ok: true });
            }),
        }),
        platform: { os: "linux", desktop: false },
      });
      const podman = makePodmanEngine({
        runner: makeControlledCommandRunner({
          run: (request) =>
            Effect.sync(() => {
              podmanCalls.push(request.args[0] ?? "");
              return commandResult({ ok: true });
            }),
        }),
        platform: { os: "linux", rootless: true },
      });
      expect((yield* selectContainerEngine({ preference: "docker", docker, podman })).kind).toBe(
        "docker",
      );
      expect((yield* selectContainerEngine({ preference: "podman", docker, podman })).kind).toBe(
        "podman",
      );
      expect(dockerCalls).toEqual([]);
      expect(podmanCalls).toEqual([]);
    }),
  );

  it.live("serializes an entrypoint override before the image", () =>
    Effect.sync(() => {
      const spec: ContainerContainerSpec = {
        name: "auth-init",
        image: "ghcr.io/supabase/cli/auth:v2.196.0",
        labels: {
          stackId,
          ownerSessionId: "owner",
          workloadId: "auth:auth",
          role: "workload",
        },
        network: "private",
        mounts: [],
        volumeMounts: [],
        publications: [],
        role: "workload",
        entrypoint: "/usr/local/bin/auth",
        command: ["migrate"],
      };
      const docker = serializeDockerCommand({ operation: "create-container", spec });
      expect(docker.args.slice(docker.args.indexOf("--entrypoint"), -2)).toEqual([
        "--entrypoint",
        "/usr/local/bin/auth",
      ]);
      expect(docker.args.indexOf("--entrypoint")).toBeLessThan(docker.args.indexOf(spec.image));
      expect(docker.args.slice(-2)).toEqual([spec.image, "migrate"]);
      const podman = serializePodmanCommand({ operation: "create-container", spec });
      expect(podman.args.indexOf("--entrypoint")).toBeLessThan(podman.args.indexOf(spec.image));
      expect(podman.args.slice(-2)).toEqual([spec.image, "migrate"]);
    }),
  );

  it.live("waits for one container and rejects malformed exit output", () =>
    Effect.gen(function* () {
      const runner = makeControlledCommandRunner({
        run: (request) =>
          Effect.succeed(commandResult(request.args[0] === "wait" ? "17\n" : "27.0.0\n")),
      });
      const docker = makeDockerEngine({
        runner,
        platform: { os: "linux", desktop: false },
      });
      expect(yield* docker.waitContainer("container-id")).toBe(17);
      const podman = makePodmanEngine({
        runner: makeControlledCommandRunner({
          run: (request) =>
            Effect.succeed(commandResult(request.args[0] === "wait" ? "17\n" : "27.0.0\n")),
        }),
        platform: { os: "linux", rootless: true },
      });
      expect(yield* podman.waitContainer("container-id")).toBe(17);
      const malformed = makeDockerEngine({
        runner: makeControlledCommandRunner({
          run: () => Effect.succeed(commandResult("17\n18\n")),
        }),
        platform: { os: "linux", desktop: false },
      });
      const result = yield* malformed.waitContainer("container-id").pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(ContainerEngineProtocolError);
      }
      const malformedPodman = makePodmanEngine({
        runner: makeControlledCommandRunner({
          run: () => Effect.succeed(commandResult("17\n18\n")),
        }),
        platform: { os: "linux", rootless: true },
      });
      const podmanResult = yield* malformedPodman.waitContainer("container-id").pipe(Effect.exit);
      expect(Exit.isFailure(podmanResult)).toBe(true);
      if (Exit.isFailure(podmanResult)) {
        const error = Cause.findErrorOption(podmanResult.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(ContainerEngineProtocolError);
      }
    }),
  );

  it.live("derives host routes before mutation and rejects unsupported hosts", () =>
    Effect.gen(function* () {
      const calls: ContainerProcessRequest[] = [];
      const runner = makeControlledCommandRunner({
        run: (command) =>
          Effect.sync(() => {
            calls.push(command);
            return commandResult({ ok: true });
          }),
      });
      const desktop = makeDockerEngine({
        runner,
        platform: { os: "darwin", desktop: true },
      });
      expect((yield* desktop.preflight).host).toBe("host.docker.internal");
      const linux = makeDockerEngine({
        runner,
        platform: { os: "linux", desktop: false },
      });
      expect((yield* linux.preflight).gateway).toBe("host-gateway");
      const podman = makePodmanEngine({
        runner,
        platform: { os: "linux", rootless: true },
      });
      expect((yield* podman.preflight).host).toBe("host.containers.internal");
      const unsupported = makeDockerEngine({
        runner,
        platform: { os: "linux", desktop: false, remote: true },
      });
      const result = yield* unsupported.preflight.pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
      }
      expect(calls).toHaveLength(0);
    }),
  );

  it.live("runs only container artifacts with exact labels, private backend and RO mounts", () =>
    Effect.gen(function* () {
      const commands: ContainerProcessRequest[] = [];
      const runner = makeControlledCommandRunner({
        run: (command) =>
          Effect.sync(() => {
            commands.push(command);
            if (
              command.args[0] === "create" ||
              (command.args[0] === "network" && command.args[1] === "create")
            )
              return commandResult(command.args[0] === "create" ? "resource-id" : "network-id");
            if (command.args[0] === "image") return commandResult("");
            if (
              command.args[0] === "ps" ||
              command.args[0] === "network" ||
              command.args[0] === "volume"
            )
              return commandResult("");
            return commandResult("");
          }),
      });
      const engine = makeDockerEngine({
        runner,
        platform: { os: "darwin", desktop: true },
      });
      const functionsWorkload = {
        ...workload(),
        id: "functions:edge-runtime" as const,
        capability: "functions" as const,
      };
      const runtime = yield* makeContainerRuntime({
        engine,
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            mounts: [{ source: "/functions", target: "/__supabase_functions", readOnly: true }],
          }),
      });
      const functionsKey = { ...key, workloadId: "functions:edge-runtime" };
      const ready = yield* runtime.start(functionsKey, functionsWorkload);
      expect(ready.state).toBe("ready");
      const create = commands.find((entry) => entry.args[0] === "create");
      expect(create).toBeDefined();
      if (create?.args !== undefined) {
        expect(create.args).not.toContain("--publish");
        expect(create.args.join(" ")).toContain("dst=/__supabase_functions,ro");
        expect(create.args.join(" ")).not.toContain("secret");
      }
      yield* runtime.stop(functionsKey);
      yield* runtime.remove(functionsKey);
    }),
  );

  it.live("runs container startup migrations before the main workload", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            envFile: "/tmp/auth.env",
            networkAliases: ["auth"],
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      expect(state.createdSpecs).toHaveLength(2);
      const [startup, main] = state.createdSpecs;
      expect(startup?.entrypoint).toBe("/usr/local/bin/auth");
      expect(startup?.command).toEqual(["migrate"]);
      expect(startup?.envFile).toBe("/tmp/auth.env");
      expect(startup?.networkAliases).toBeUndefined();
      expect(startup?.publications).toEqual([]);
      expect(main?.entrypoint).toBeUndefined();
      expect(main?.command).toBeUndefined();
      expect(main?.envFile).toBe("/tmp/auth.env");
      expect(main?.networkAliases).toEqual(["auth"]);
      const startupStart = state.calls.findIndex((call) => call.startsWith("start:"));
      const startupWait = state.calls.findIndex((call) => call.startsWith("wait:"));
      const startupRemove = state.calls.findIndex((call) => call.startsWith("remove:"));
      expect(startupStart).toBeGreaterThanOrEqual(0);
      expect(startupWait).toBeGreaterThan(startupStart);
      expect(startupRemove).toBeGreaterThan(startupWait);
      yield* runtime.stop(key);
    }),
  );

  it.live("publishes an unexpected container workload exit after readiness", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const exit = yield* Deferred.make<number, never>();
      const base = fakeContainerEngine(state);
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...base,
          waitContainer: (resourceId) =>
            state.calls.includes(`wait:${resourceId}`)
              ? Deferred.await(exit)
              : base.waitContainer(resourceId),
        },
        ownerSessionId: "owner-session",
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      yield* Deferred.succeed(exit, 17);
      yield* Effect.yieldNow;
      const observed = yield* runtime.observe(stackId);
      expect(observed).toEqual([
        expect.objectContaining({ workloadId: key.workloadId, state: "failed" }),
      ]);
      yield* runtime.remove(key);
    }),
  );

  it.live("ignores an interrupt-only one-shot log follower exit", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      let streamCalls = 0;
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: () => {
            streamCalls += 1;
            return streamCalls === 1 ? Stream.failCause(Cause.interrupt()) : Stream.empty;
          },
        },
        ownerSessionId: "owner-session",
        logStore: memoryLogStore([]),
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      expect(streamCalls).toBe(2);
      yield* runtime.stop(key);
    }),
  );

  it.live("hides in-flight startup containers from observation", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const waitEntered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<number, never>();
      const base = fakeContainerEngine(state);
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...base,
          waitContainer: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(waitEntered, undefined);
              return yield* Deferred.await(gate);
            }),
        },
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            envFile: "/tmp/auth.env",
            networkAliases: ["auth"],
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const running = yield* runtime
        .start(key, workload())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waitEntered);
      expect(yield* runtime.observe(key.stackId)).toEqual([]);
      yield* Deferred.succeed(gate, 0);
      expect(yield* Fiber.join(running)).toEqual({ ...key, state: "ready" });
      expect(yield* runtime.observe(key.stackId)).toEqual([{ ...key, state: "ready" }]);
      const [startup, main] = state.createdSpecs;
      expect(startup?.envFile).toBe("/tmp/auth.env");
      expect(startup?.networkAliases).toBeUndefined();
      expect(startup?.publications).toEqual([]);
      expect(main?.networkAliases).toEqual(["auth"]);
      yield* runtime.stop(key);
    }),
  );

  it.live("runs multiple startup processes sequentially before the main workload", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [
              { entrypoint: "/usr/local/bin/auth", command: ["first"] },
              { entrypoint: "/usr/local/bin/auth", command: ["second"] },
            ],
          }),
      });
      expect(yield* runtime.start(key, workload())).toEqual({ ...key, state: "ready" });
      expect(state.createdSpecs.map((spec) => spec.command)).toEqual([
        ["first"],
        ["second"],
        undefined,
      ]);
      const waits = state.calls.filter((call) => call.startsWith("wait:"));
      const removes = state.calls.filter((call) => call.startsWith("remove:"));
      expect(waits).toHaveLength(2);
      expect(removes).toHaveLength(2);
      const firstRemove = removes[0];
      const secondWait = waits[1];
      expect(firstRemove).toBeDefined();
      expect(secondWait).toBeDefined();
      if (firstRemove !== undefined && secondWait !== undefined)
        expect(state.calls.indexOf(secondWait)).toBeGreaterThan(state.calls.indexOf(firstRemove));
      yield* runtime.stop(key);
    }),
  );

  it.live("blocks the main workload and removes the init container on migration failure", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
        waitExitCode: 17,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.createdSpecs).toHaveLength(1);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
      expect(state.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
    }),
  );

  it.effect("times out a startup migration and removes the exact init container", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const waitEntered = yield* Deferred.make<void>();
      const waitForever = yield* Deferred.make<number, never>();
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          waitContainer: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(waitEntered, undefined);
              return yield* Deferred.await(waitForever);
            }),
        },
        ownerSessionId: "owner-session",
        startupProcessTimeout: "5 seconds",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const running = yield* runtime
        .start(key, workload())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waitEntered);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(running).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(RuntimeDriverError);
          expect(error.value.message).toContain("startup process timed out");
        }
      }
      expect(state.createdSpecs).toHaveLength(1);
      expect(state.calls.filter((call) => call.startsWith("start:")).length).toBe(1);
      expect(state.calls.filter((call) => call.startsWith("remove:")).length).toBe(1);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
    }),
  );

  it.live("keeps a nonzero migration exit authoritative when log persistence also fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
        waitExitCode: 17,
      };
      const logError = new LogStoreError({
        path: "memory://container-logs-failure",
        message: "disk full",
      });
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: () =>
            Stream.fromIterable([
              { stream: "stdout", message: "migration-output" } satisfies ContainerLogLine,
            ]),
        },
        ownerSessionId: "owner-session",
        logStore: {
          path: logError.path,
          append: () => Effect.fail(logError),
          read: () => Effect.succeed([]),
        },
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const message = Cause.pretty(result.cause);
        expect(message).toContain("code 17");
        expect(message).toContain("disk full");
      }
      expect(state.createdSpecs).toHaveLength(1);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
    }),
  );

  it.live("blocks the main workload when startup log persistence fails after exit zero", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const logError = new LogStoreError({
        path: "memory://container-logs-failure",
        message: "disk full",
      });
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: () =>
            Stream.fromIterable([
              { stream: "stdout", message: "migration-output" } satisfies ContainerLogLine,
            ]),
        },
        ownerSessionId: "owner-session",
        logStore: {
          path: logError.path,
          append: () => Effect.fail(logError),
          read: () => Effect.succeed([]),
        },
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.createdSpecs).toHaveLength(1);
      expect(state.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("disk full");
    }),
  );

  it.live("persists startup stdout and stderr before removing the init container", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const records: LogRecord[] = [];
      const streamStates: Array<string | undefined> = [];
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: (id) => {
            const resource = state.resources.find((entry) => entry.id === id);
            streamStates.push(resource?.state);
            return resource?.state === "running" &&
              resource.labels.role === "workload" &&
              resource.labels.startup === true
              ? Stream.fromIterable([
                  { stream: "stdout", message: "migrated" } satisfies ContainerLogLine,
                  { stream: "stderr", message: "notice" } satisfies ContainerLogLine,
                ])
              : Stream.empty;
          },
        },
        ownerSessionId: "owner-session",
        logStore: memoryLogStore(records),
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      yield* runtime.start(key, workload());
      expect(streamStates).toEqual(["running", "running"]);
      expect(records.map((record) => [record.stream, record.message])).toEqual([
        ["stdout", "migrated"],
        ["stderr", "notice"],
      ]);
    }),
  );

  it.live("cleans an interrupted init container", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const waitEntered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<number, never>();
      const base = fakeContainerEngine(state);
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...base,
          waitContainer: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(waitEntered, undefined);
              return yield* Deferred.await(gate).pipe(Effect.as(0));
            }),
        },
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const running = yield* runtime
        .start(key, workload())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waitEntered);
      yield* Fiber.interrupt(running);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
      expect(state.createdSpecs).toHaveLength(1);
    }),
  );

  it.live("allows stop to interrupt a blocked container readiness", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            waitForReadiness: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
          }),
      });
      const starting = yield* runtime
        .start(key, workload())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* runtime.stop(key);
      const failed = yield* Fiber.join(starting).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.live("does not let cleanup race an in-flight container creation", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const createEntered = yield* Deferred.make<void>();
      const releaseCreate = yield* Deferred.make<void>();
      const base = fakeContainerEngine(state);
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...base,
          createContainer: (spec) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(createEntered, undefined);
              yield* Deferred.await(releaseCreate);
              return yield* base.createContainer(spec);
            }),
        },
        ownerSessionId: "owner-session",
      });
      const starting = yield* runtime
        .start(key, workload())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(createEntered);

      // Cleanup must interrupt the start before it can create an unowned container.
      yield* runtime.cleanup({ stackId, destroy: true });
      yield* Deferred.succeed(releaseCreate, undefined);
      const startExit = yield* Fiber.join(starting).pipe(Effect.exit);
      expect(Exit.isFailure(startExit)).toBe(true);

      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
    }),
  );

  it.live("does not adopt an exact main container when starting a new session", () =>
    Effect.gen(function* () {
      const existing: ContainerResource = {
        id: "existing-main",
        name: "supabase-aaaaaaaaaaaaaaaa-database_database-workload",
        kind: "workload",
        state: "running",
        labels: {
          stackId,
          ownerSessionId: "owner-session",
          workloadId: key.workloadId,
          role: "workload",
        },
      };
      const state: FakeContainerState = {
        resources: [existing],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      expect(state.createdSpecs).toHaveLength(2);
      expect(state.calls.some((call) => call.startsWith("wait:"))).toBe(true);
    }),
  );

  it.live("removes an interrupted startup container before retrying the workload", () =>
    Effect.gen(function* () {
      const stale: ContainerResource = {
        id: "stale-startup",
        name: `supabase-${stackId.slice(0, 16)}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-workload`,
        kind: "workload",
        state: "stopped",
        labels: {
          stackId,
          ownerSessionId: "owner-session",
          workloadId: key.workloadId,
          startup: true,
          role: "workload",
        },
      };
      const state: FakeContainerState = {
        resources: [stale],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            startup: [{ entrypoint: "/usr/local/bin/auth", command: ["migrate"] }],
          }),
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      expect(state.calls).toContain("remove:stale-startup");
      expect(state.createdSpecs).toHaveLength(2);
    }),
  );

  it.live("rejects native artifacts before invoking the engine", () =>
    Effect.gen(function* () {
      let called = false;
      const runner = makeControlledCommandRunner({
        run: () =>
          Effect.sync(() => {
            called = true;
            return commandResult({});
          }),
      });
      const runtime = yield* makeContainerRuntime({
        engine: makeDockerEngine({ runner, platform: { os: "darwin", desktop: true } }),
        ownerSessionId: "owner-session",
      });
      const result = yield* runtime
        .start(key, workload({ kind: "native", release: "1" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(called).toBe(false);
    }),
  );

  it.live(
    "captures container logs before readiness and does not duplicate same-resource followers",
    () =>
      Effect.gen(function* () {
        const state: FakeContainerState = {
          resources: [],
          imagePresent: true,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const records: LogRecord[] = [];
        const appended = yield* Deferred.make<void>();
        let followerCalls = 0;
        let followerAttached = false;
        const base = fakeContainerEngine(state);
        const baseLogStore = memoryLogStore(records);
        const logStore: LogStore = {
          ...baseLogStore,
          append: (record) =>
            baseLogStore
              .append(record)
              .pipe(Effect.tap(() => Deferred.succeed(appended, undefined))),
        };
        const engine: ContainerEngine = {
          ...base,
          streamLogs: () => {
            followerCalls += 1;
            followerAttached = true;
            return Stream.fromIterable([
              { stream: "stdout", message: "container-started" } satisfies ContainerLogLine,
            ]);
          },
        };
        const runtime = yield* makeContainerRuntime({
          engine,
          ownerSessionId: "owner-session",
          logStore,
          resolveWorkload: () =>
            Effect.succeed({
              waitForReadiness: () =>
                followerAttached
                  ? Effect.void
                  : Effect.fail(
                      new RuntimeDriverError({
                        message: "logs not attached",
                        stackId: key.stackId,
                        workloadId: key.workloadId,
                      }),
                    ),
            }),
        });
        const ready = yield* runtime.start(key, workload());
        expect(ready.state).toBe("ready");
        expect(followerCalls).toBe(1);
        yield* Deferred.await(appended);
        expect(records.map((record) => record.message)).toEqual(["container-started"]);
        yield* runtime.start(key, workload());
        expect(followerCalls).toBe(1);
        yield* runtime.stop(key);
        expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      }),
  );

  it.live("keeps following logs after a non-destructive cleanup and restart", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const records: LogRecord[] = [];
      const firstAppended = yield* Deferred.make<void>();
      const secondAppended = yield* Deferred.make<void>();
      let followerCalls = 0;
      const base = fakeContainerEngine(state);
      const baseLogStore = memoryLogStore(records);
      const logStore: LogStore = {
        ...baseLogStore,
        append: (record) =>
          baseLogStore
            .append(record)
            .pipe(
              Effect.tap(() =>
                records.length === 1
                  ? Deferred.succeed(firstAppended, undefined)
                  : Deferred.succeed(secondAppended, undefined),
              ),
            ),
      };
      const engine: ContainerEngine = {
        ...base,
        streamLogs: () => {
          const sequence = followerCalls + 1;
          followerCalls += 1;
          return Stream.fromIterable([
            {
              stream: "stdout",
              message: `container-started-${sequence}`,
            } satisfies ContainerLogLine,
          ]);
        },
      };
      const runtime = yield* makeContainerRuntime({
        engine,
        ownerSessionId: "owner-session",
        logStore,
      });

      yield* runtime.start(key, workload());
      yield* Deferred.await(firstAppended);
      yield* runtime.cleanup({ stackId: key.stackId, destroy: false });

      const restartedKey: RuntimeWorkloadKey = key;
      const restartedWorkload: PlannedWorkload = workload();
      yield* runtime.start(restartedKey, restartedWorkload);
      yield* Deferred.await(secondAppended);

      expect(followerCalls).toBe(2);
      expect(records.map((record) => record.message)).toEqual([
        "container-started-1",
        "container-started-2",
      ]);
    }),
  );

  it.live("propagates restart-session log failures after a non-destructive cleanup", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const readiness = yield* Deferred.make<void>();
      const followerAttached = yield* Deferred.make<void>();
      const followerFailure = yield* Deferred.make<never, ContainerEngineProtocolError>();
      const restartedKey: RuntimeWorkloadKey = key;
      const restartedWorkload: PlannedWorkload = workload();
      let starts = 0;
      let followerCalls = 0;
      const engine: ContainerEngine = {
        ...fakeContainerEngine(state),
        waitContainer: () => Effect.never,
        streamLogs: () => {
          followerCalls += 1;
          return followerCalls === 1
            ? Stream.empty
            : Stream.fromEffect(
                Effect.gen(function* () {
                  yield* Deferred.succeed(followerAttached, undefined);
                  return yield* Deferred.await(followerFailure);
                }),
              );
        },
      };
      const runtime = yield* makeContainerRuntime({
        engine,
        ownerSessionId: "owner-session",
        logStore: memoryLogStore([]),
        resolveWorkload: (requestKey) =>
          Effect.succeed({
            waitForReadiness:
              requestKey.workloadId === restartedKey.workloadId
                ? () => {
                    starts += 1;
                    return starts === 1 ? Effect.void : Deferred.await(readiness);
                  }
                : undefined,
          }),
      });

      yield* runtime.start(key, workload());
      yield* runtime.cleanup({ stackId: key.stackId, destroy: false });

      const starting = yield* runtime
        .start(restartedKey, restartedWorkload)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(followerAttached);
      yield* Deferred.fail(
        followerFailure,
        new ContainerEngineProtocolError({
          operation: "logs",
          message: "restart-session follower disconnected",
        }),
      );
      const result = yield* Fiber.join(starting).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(RuntimeDriverError);
          expect(error.value.message).toBe("restart-session follower disconnected");
          expect(error.value.cause).toBeInstanceOf(ContainerEngineError);
        }
      }
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
    }),
  );

  it.live("fails startup and removes a new container when log persistence fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const logError = new LogStoreError({
        path: "memory://container-logs-failure",
        message: "disk full",
      });
      const readiness = yield* Deferred.make<void>();
      const logStore: LogStore = {
        path: logError.path,
        append: () => Effect.fail(logError),
        read: () => Effect.succeed([]),
      };
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: () =>
            Stream.fromIterable([
              { stream: "stdout", message: "will-not-persist" } satisfies ContainerLogLine,
            ]),
        },
        ownerSessionId: "owner-session",
        logStore,
        resolveWorkload: () =>
          Effect.succeed({ waitForReadiness: () => Deferred.await(readiness) }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
    }),
  );

  it.live("marks a running container failed when its log follower fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const followerFailure = yield* Deferred.make<never, ContainerEngineProtocolError>();
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...fakeContainerEngine(state),
          streamLogs: () => Stream.fromEffect(Deferred.await(followerFailure)),
        },
        ownerSessionId: "owner-session",
        logStore: memoryLogStore([]),
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      yield* Deferred.fail(
        followerFailure,
        new ContainerEngineProtocolError({
          operation: "logs",
          message: "follower disconnected",
        }),
      );
      yield* Effect.yieldNow;
      const observed = yield* runtime.observe(key.stackId);
      expect(observed[0]?.state).toBe("failed");
      yield* runtime.stop(key);
    }),
  );

  it.live("rejects malformed inspect output and workload port publication", () =>
    Effect.gen(function* () {
      let calls = 0;
      const malformed = makeDockerEngine({
        runner: makeControlledCommandRunner({
          run: () =>
            Effect.sync(() => {
              calls += 1;
              return commandResult(
                '{"ID":"bad","Names":"bad","Labels":{},"State":"running","extra":true}',
              );
            }),
        }),
        platform: { os: "linux", desktop: false },
      });
      const malformedExit = yield* malformed.listResources(stackId).pipe(Effect.exit);
      expect(Exit.isFailure(malformedExit)).toBe(true);
      if (Exit.isFailure(malformedExit)) {
        const error = Cause.findErrorOption(malformedExit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(ContainerEngineProtocolError);
      }
      const engine = makeDockerEngine({
        runner: makeControlledCommandRunner({
          run: () =>
            Effect.sync(() => {
              calls += 1;
              return commandResult("");
            }),
        }),
        platform: { os: "linux", desktop: false },
      });
      const result = yield* engine
        .createContainer({
          name: "backend",
          image: "example/backend:1",
          labels: {
            stackId,
            ownerSessionId: "owner-session",
            workloadId: "database:database",
            role: "workload",
          },
          network: "private",
          mounts: [],
          publications: [{ address: "127.0.0.1", hostPort: 5432, containerPort: 5432 }],
          volumeMounts: [],
          role: "workload",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(calls).toBe(2);
    }),
  );

  it.live("decodes Docker closed rows and image outcomes", () =>
    Effect.gen(function* () {
      const dockerJsonRow = (values: ReadonlyArray<string>): string =>
        values.map((value) => JSON.stringify(value)).join("\t");
      const runner = makeControlledCommandRunner({
        run: (request) =>
          Effect.succeed({
            stdout:
              request.args[0] === "image"
                ? request.args[2] === "present"
                  ? '"sha256:present"\n'
                  : request.args[2] === "malformed"
                    ? "not-json\n"
                    : ""
                : request.args[0] === "ps"
                  ? `${dockerJsonRow(["container-id", "backend", stackId, "owner", key.workloadId, "false", "workload", "running"])}\n`
                  : request.args[0] === "network" && request.args[1] === "create"
                    ? "created-id\nsecond\n"
                    : request.args[0] === "network"
                      ? `${dockerJsonRow(["network-id", "private", stackId, "owner", "network"])}\n`
                      : request.args[0] === "volume"
                        ? `${dockerJsonRow(["volume-name", stackId, key.workloadId, "volume"])}\n`
                        : request.args[0] === "version"
                          ? '"27.0.0"\n'
                          : "created-id\n",
            stderr: "",
            exitCode: request.args[0] === "nonzero" ? 17 : 0,
          }),
      });
      const engine = makeDockerEngine({
        runner,
        platform: { os: "linux", desktop: false },
      });
      yield* engine.probe;
      expect((yield* engine.inspectImage("absent")).present).toBe(false);
      expect((yield* engine.inspectImage("present")).present).toBe(true);
      const malformed = yield* engine.inspectImage("malformed").pipe(Effect.exit);
      expect(Exit.isFailure(malformed)).toBe(true);
      const resources = yield* engine.listResources(stackId);
      expect(resources.map((resource) => resource.kind)).toEqual(["workload", "network", "volume"]);
      expect(resources[0]?.labels.role).toBe("workload");
      expect(resources[1]?.labels.role).toBe("network");
      expect(resources[2]?.labels.role).toBe("volume");
      const multiline = yield* engine
        .createNetwork({
          name: "private",
          labels: { stackId, ownerSessionId: "owner", role: "network" },
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(multiline)).toBe(true);
    }),
  );

  it.live("keeps Docker and Podman command codecs independent and closed", () =>
    Effect.gen(function* () {
      const workload = {
        name: "backend",
        image: "example/backend:1",
        labels: {
          stackId,
          ownerSessionId: "owner",
          workloadId: "backend",
          role: "workload" as const,
        },
        network: "private",
        mounts: [],
        volumeMounts: [],
        publications: [{ address: "127.0.0.1" as const, hostPort: 54321, containerPort: 8000 }],
        envFile: "/tmp/supabase-owned.env",
        networkAliases: ["supabase-database"],
        command: ["serve", "--port", "8000"],
        hostRoute: { host: "host.docker.internal", gateway: "host-gateway" },
        role: "workload" as const,
      };
      const docker = serializeDockerCommand({ operation: "create-container", spec: workload });
      expect(docker.args).toContain("--add-host");
      expect(docker.args).toContain("host.docker.internal:host-gateway");
      expect(docker.args).toContain("--publish");
      expect(docker.args).toContain("127.0.0.1:54321:8000");
      expect(docker.args).toContain("--network-alias");
      expect(docker.args).toContain("supabase-database");
      expect(docker.args).toContain("--env-file");
      expect(docker.args).toContain("/tmp/supabase-owned.env");
      expect(docker.args.join(" ")).not.toContain("value");
      expect(docker.args.slice(-3)).toEqual(["serve", "--port", "8000"]);
      const podmanCreate = serializePodmanCommand({
        operation: "create-container",
        spec: workload,
      });
      expect(podmanCreate.args).toContain("--env-file");
      expect(podmanCreate.args).toContain("127.0.0.1:54321:8000");
      expect(podmanCreate.args).toContain("--network-alias");
      expect(podmanCreate.args).toContain("/tmp/supabase-owned.env");
      expect(podmanCreate.args.join(" ")).not.toContain("value");
      expect(podmanCreate.args.slice(-3)).toEqual(["serve", "--port", "8000"]);
      const podman = serializePodmanCommand({ operation: "inspect-networks", stackId });
      expect(podman.args.join(" ")).toContain("{{index .Labels");
      expect(podman.args.join(" ")).not.toContain("host-gateway");
      expect(
        serializeDockerCommand({
          operation: "copy-container",
          id: "container-id",
          source: "/tmp/functions-main.ts",
          destination: "/root",
        }).args,
      ).toEqual(["cp", "/tmp/functions-main.ts", "container-id:/root"]);
      expect(
        serializePodmanCommand({
          operation: "copy-container",
          id: "container-id",
          source: "/tmp/functions-main.ts",
          destination: "/root",
        }).args,
      ).toEqual(["cp", "/tmp/functions-main.ts", "container-id:/root"]);
      const unsupported = yield* makePodmanEngine({
        runner: makeControlledCommandRunner({ run: () => Effect.succeed(commandResult("ok")) }),
        platform: { os: "darwin" },
      }).preflight.pipe(Effect.exit);
      expect(Exit.isFailure(unsupported)).toBe(true);

      const rowRunner = makeControlledCommandRunner({
        run: (request) =>
          Effect.succeed({
            stdout:
              request.args[0] === "version"
                ? "5.0.0\n"
                : request.args[0] === "image"
                  ? request.args[2] === "present"
                    ? "sha256:present\n"
                    : request.args[2] === "malformed"
                      ? "bad\trow\n"
                      : ""
                  : request.args[0] === "ps"
                    ? `container-id\tbackend\t${stackId}\towner\t${key.workloadId}\tfalse\tworkload\trunning\n`
                    : request.args[0] === "network"
                      ? `network-id\tprivate\t${stackId}\towner\tnetwork\n`
                      : request.args[0] === "volume"
                        ? `volume-name\t${stackId}\t${key.workloadId}\tvolume\n`
                        : "created-id\n",
            stderr: "",
            exitCode: 0,
          }),
      });

      const podmanEngine = makePodmanEngine({
        runner: rowRunner,
        platform: { os: "linux", rootless: true },
      });
      yield* podmanEngine.probe;
      expect((yield* podmanEngine.inspectImage("absent")).present).toBe(false);
      expect((yield* podmanEngine.inspectImage("present")).present).toBe(true);
      const malformedImage = yield* podmanEngine.inspectImage("malformed").pipe(Effect.exit);
      expect(Exit.isFailure(malformedImage)).toBe(true);
      const podmanResources = yield* podmanEngine.listResources(stackId);
      expect(podmanResources.map((resource) => resource.kind)).toEqual([
        "workload",
        "network",
        "volume",
      ]);
    }),
  );

  it.live("follows one Docker or Podman log process and joins split stdout/stderr lines", () =>
    Effect.gen(function* () {
      const requests: ContainerProcessRequest[] = [];
      const chunks: ReadonlyArray<{
        readonly stream: "stdout" | "stderr";
        readonly bytes: Uint8Array;
      }> = [
        { stream: "stdout", bytes: new TextEncoder().encode("first\nsec") },
        { stream: "stderr", bytes: new TextEncoder().encode("error\nlast") },
        { stream: "stdout", bytes: new TextEncoder().encode("ond\n") },
      ];
      const runner = makeControlledCommandRunner({
        run: () => Effect.succeed(commandResult("ok")),
        stream: (request) => {
          requests.push(request);
          return Stream.fromIterable(chunks);
        },
      });
      const docker = makeDockerEngine({
        runner,
        platform: { os: "linux", desktop: false },
      });
      const podman = makePodmanEngine({
        runner,
        platform: { os: "linux", rootless: true },
      });
      const dockerLogs = yield* Stream.runCollect(docker.streamLogs!("container-id", { tail: 0 }));
      const podmanLogs = yield* Stream.runCollect(podman.streamLogs!("podman-id"));
      expect(dockerLogs).toEqual([
        { stream: "stdout", message: "first" },
        { stream: "stderr", message: "error" },
        { stream: "stdout", message: "second" },
        { stream: "stderr", message: "last" },
      ] satisfies ReadonlyArray<ContainerLogLine>);
      expect(podmanLogs).toEqual(dockerLogs);
      expect(requests.map((request) => request.args)).toEqual([
        ["logs", "--follow", "--tail", "0", "container-id"],
        ["logs", "--follow", "--tail", "all", "podman-id"],
      ]);
    }),
  );

  it.live("rejects non-loopback publications before preflight or daemon mutation", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      let preflightCalls = 0;
      const base = fakeContainerEngine(state);
      const runtime = yield* makeContainerRuntime({
        engine: {
          ...base,
          preflight: Effect.sync(() => {
            preflightCalls += 1;
            return { host: "host.docker.internal" };
          }),
        },
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({
            publications: [{ address: "0.0.0.0", hostPort: 30_000, containerPort: 8080 }],
          }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(preflightCalls).toBe(0);
      expect(state.calls).toEqual([]);
      expect(state.createdSpecs).toEqual([]);
    }),
  );

  it.live("fails process output overflow and nonzero commands with typed failures", () =>
    Effect.gen(function* () {
      const runner = yield* makeProcessCommandRunner({
        executable: process.execPath,
        baseArgs: ["-e", "process.stdout.write('123456'); process.stderr.write('abcdef')"],
        maxOutputBytes: 4,
      });
      const overflow = yield* runner.run({ args: ["probe"] }).pipe(Effect.exit);
      expect(Exit.isFailure(overflow)).toBe(true);
      const nonzero = makeControlledCommandRunner({
        run: () => Effect.succeed({ stdout: "", stderr: "daemon unavailable", exitCode: 17 }),
      });
      const engine = makeDockerEngine({ runner: nonzero, platform: { os: "linux" } });
      const failure = yield* engine.probe.pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) {
        const error = Cause.findErrorOption(failure.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(ContainerCommandError);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "fails fast on a noisy process and force-reaps one that ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const runner = yield* makeProcessCommandRunner({
          executable: process.execPath,
          baseArgs: [
            "-e",
            "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)",
          ],
          maxOutputBytes: 16,
        });
        const result = yield* runner
          .run({ args: ["probe"] })
          .pipe(Effect.timeout("8 seconds"), Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error))
            expect(error.value).toBeInstanceOf(ContainerEngineProtocolError);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    10_000,
  );

  it.live("replaces an exact running container for each new start session", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
      });
      yield* runtime.start(key, workload());
      const nextRuntime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "next-owner-session",
      });
      state.calls.length = 0;
      yield* nextRuntime.start(key, workload());
      expect(state.calls).toContain("inspect-image");
      expect(state.calls).toContain("create-container");
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
    }),
  );

  it.live("recreates a same-stack network owned by a previous start session", () =>
    Effect.gen(function* () {
      const networkName = `supabase-${key.stackId.slice(0, 16)}-network`;
      const state: FakeContainerState = {
        resources: [
          {
            id: "stale-network",
            name: networkName,
            kind: "network",
            labels: {
              stackId: key.stackId,
              ownerSessionId: "previous-owner",
              role: "network",
            },
          },
        ],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "current-owner",
      });

      yield* runtime.start(key, workload());

      const removeIndex = state.calls.findIndex((call) => call === "remove-network:stale-network");
      const createIndex = state.calls.findIndex((call) => call === "create-network");
      expect(removeIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(removeIndex);
      expect(
        state.resources.some(
          (resource) =>
            resource.kind === "network" &&
            resource.labels.role === "network" &&
            resource.labels.ownerSessionId === "current-owner",
        ),
      ).toBe(true);
    }),
  );

  it.live("leaves foreign and sanitized-name collisions untouched", () =>
    Effect.gen(function* () {
      const foreignStackId = StackIdSchema.make("c".repeat(64));
      const foreignKey = { ...key, stackId: foreignStackId, workloadId: "api:api" };
      const foreignName = `supabase-${stackId.slice(0, 16)}-api-api-workload`;
      const state: FakeContainerState = {
        resources: [
          {
            id: "foreign-container",
            name: foreignName,
            kind: "workload",
            state: "running",
            labels: {
              stackId: foreignStackId,
              ownerSessionId: "other-session",
              workloadId: foreignKey.workloadId,
              role: "workload",
            },
          },
        ],
        imagePresent: false,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
      });
      const foreign = yield* runtime
        .start({ ...foreignKey, stackId }, workload())
        .pipe(Effect.exit);
      expect(Exit.isFailure(foreign)).toBe(true);
      expect(state.calls).not.toContain("pull-image");
      expect(state.calls).not.toContain("create-container");
      expect(state.resources[0]?.id).toBe("foreign-container");

      const firstKey = { ...key, workloadId: "foo/bar" };
      const secondKey = { ...key, workloadId: "foo?bar" };
      state.resources = [];
      state.calls.length = 0;
      yield* runtime.start(firstKey, workload());
      state.calls.length = 0;
      const sanitized = yield* runtime.start(secondKey, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(sanitized)).toBe(true);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(false);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(false);
      expect(state.resources.filter((resource) => resource.kind === "workload")).toHaveLength(1);
    }),
  );

  it.live(
    "derives volume mounts, preserves volumes on remove, and validates mappings before mutation",
    () =>
      Effect.gen(function* () {
        const state: FakeContainerState = {
          resources: [],
          imagePresent: true,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const volume = { target: "/var/lib/postgresql/data", readOnly: false };
        const runtime = yield* makeContainerRuntime({
          engine: fakeContainerEngine(state),
          ownerSessionId: "owner-session",
          resolveWorkload: () => Effect.succeed({ volume }),
        });
        yield* runtime.start(key, workload());
        const physicalVolumeName = `supabase-${key.stackId}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-volume`;
        expect(state.createdSpecs[0]?.volumeMounts).toEqual([
          { volume: physicalVolumeName, target: volume.target, readOnly: false },
        ]);
        expect(state.resources.some((resource) => resource.kind === "volume")).toBe(true);
        yield* runtime.remove(key);
        expect(state.resources.some((resource) => resource.kind === "volume")).toBe(true);
        expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);

        const otherStackKey = {
          ...key,
          stackId: StackIdSchema.make("b".repeat(64)),
        };
        yield* runtime.start(otherStackKey, workload());
        expect(state.resources.filter((resource) => resource.kind === "volume")).toHaveLength(2);
        state.calls.length = 0;
        const nextRuntime = yield* makeContainerRuntime({
          engine: fakeContainerEngine(state),
          ownerSessionId: "next-owner-session",
          resolveWorkload: () =>
            Effect.succeed({ bootstrap: { source: "/tmp/main.ts", destination: "/root" } }),
        });
        yield* nextRuntime.start(key, workload());
        expect(state.calls).not.toContain(`create-volume:${physicalVolumeName}`);

        const invalidState: FakeContainerState = {
          resources: [],
          imagePresent: false,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const invalidRuntime = yield* makeContainerRuntime({
          engine: fakeContainerEngine(invalidState),
          ownerSessionId: "owner-session",
          resolveWorkload: () =>
            Effect.succeed({ volume: { target: "", readOnly: volume.readOnly } }),
        });
        const invalid = yield* invalidRuntime.start(key, workload()).pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        expect(invalidState.calls).not.toContain("inspect-image");
        expect(invalidState.calls).not.toContain("create-network");
      }),
  );

  it.live("shares one owner volume across read-only and read-write workloads", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const ownerKey: RuntimeWorkloadKey = {
        ...key,
        workloadId: "storage:storage",
      };
      const secondaryKey: RuntimeWorkloadKey = {
        ...key,
        workloadId: "storage:imgproxy",
      };
      const ownerWorkload = {
        ...workload(),
        id: ownerKey.workloadId,
        capability: "storage" as const,
      };
      const secondaryWorkload = {
        ...workload(),
        id: secondaryKey.workloadId,
        capability: "storage" as const,
      };
      const ownerWorkloadId = ownerKey.workloadId;
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: (requestKey) =>
          Effect.succeed({
            volume:
              requestKey.workloadId === ownerWorkloadId
                ? { target: "/var/lib/storage", readOnly: false, ownerWorkloadId }
                : { target: "/mnt", readOnly: true, ownerWorkloadId },
          }),
      });

      // A read-only dependent can materialize and own the shared volume first.
      yield* runtime.start(secondaryKey, secondaryWorkload);
      yield* runtime.start(ownerKey, ownerWorkload);

      const expectedVolume = `supabase-${stackId}-${ownerWorkloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-volume`;
      expect(state.resources.filter((resource) => resource.kind === "volume")).toHaveLength(1);
      expect(state.resources.find((resource) => resource.kind === "volume")?.name).toBe(
        expectedVolume,
      );
      expect(state.calls.filter((call) => call.startsWith("create-volume:"))).toEqual([
        `create-volume:${expectedVolume}`,
      ]);
      expect(state.createdSpecs.map((spec) => spec.volumeMounts[0])).toEqual([
        { volume: expectedVolume, target: "/mnt", readOnly: true },
        { volume: expectedVolume, target: "/var/lib/storage", readOnly: false },
      ]);

      yield* runtime.stop(secondaryKey);
      yield* runtime.stop(ownerKey);
      expect(state.resources.filter((resource) => resource.kind === "volume")).toHaveLength(1);
      const sharedVolume = state.resources.find((resource) => resource.kind === "volume");
      expect(sharedVolume).toBeDefined();
      if (sharedVolume === undefined) return;
      yield* runtime.cleanup({ stackId, destroy: true });
      expect(state.calls.filter((call) => call.startsWith("remove-volume:"))).toEqual([
        `remove-volume:${sharedVolume.id}`,
      ]);
    }),
  );

  it.live(
    "cleans up a newly created container when readiness fails and keeps the original cause",
    () =>
      Effect.gen(function* () {
        const state: FakeContainerState = {
          resources: [],
          imagePresent: true,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const readinessError = new RuntimeDriverError({
          message: "database did not become ready",
          stackId: key.stackId,
          workloadId: key.workloadId,
        });
        const runtime = yield* makeContainerRuntime({
          engine: fakeContainerEngine(state),
          ownerSessionId: "owner-session",
          resolveWorkload: () =>
            Effect.succeed({ waitForReadiness: () => Effect.fail(readinessError) }),
        });
        const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value).toBe(readinessError);
        }
        expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
        expect(state.resources.some((resource) => resource.kind === "network")).toBe(true);
        expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
        expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
      }),
  );

  it.live("runs database bootstrap after readiness and before reporting ready", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const order: string[] = [];
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({ waitForReadiness: () => Effect.sync(() => order.push("readiness")) }),
        bootstrapDatabase: () => Effect.sync(() => order.push("bootstrap")),
      });
      const databaseWorkload = { ...workload(), bootstrap: "database" as const };
      const databaseReady = yield* runtime.start(key, databaseWorkload);
      expect(databaseReady.state).toBe("ready");
      expect(order).toEqual(["readiness", "bootstrap"]);
    }),
  );

  it.live("cleans up a newly created container when database bootstrap fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const bootstrapError = new RuntimeDriverError({
        message: "database bootstrap failed",
        stackId: key.stackId,
        workloadId: key.workloadId,
      });
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        bootstrapDatabase: () => Effect.fail(bootstrapError),
      });
      const databaseWorkload = { ...workload(), bootstrap: "database" as const };
      const result = yield* runtime.start(key, databaseWorkload).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBe(bootstrapError);
      }
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
    }),
  );

  it.live("removes a replaced running database container on bootstrap failure", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const owner = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "previous-owner",
      });
      yield* owner.start(key, workload());
      state.calls.length = 0;
      const bootstrapError = new RuntimeDriverError({
        message: "replaced database bootstrap failed",
        stackId: key.stackId,
        workloadId: key.workloadId,
      });
      let attempts = 0;
      const replacementRuntime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "new-owner",
        bootstrapDatabase: () =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) return yield* bootstrapError;
          }),
      });
      const result = yield* replacementRuntime
        .start(key, { ...workload(), bootstrap: "database" as const })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
      const retry = yield* replacementRuntime.start(key, {
        ...workload(),
        bootstrap: "database" as const,
      });
      expect(retry.state).toBe("ready");
      expect(attempts).toBe(2);
    }),
  );

  it.live("copies a new functions bootstrap on each fresh start", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({ bootstrap: { source: "/tmp/main.ts", destination: "/root" } }),
      });
      yield* runtime.start(key, workload());
      const copyIndex = state.calls.findIndex((call) => call.startsWith("copy:"));
      const startIndex = state.calls.findIndex((call) => call.startsWith("start:"));
      expect(copyIndex).toBeGreaterThanOrEqual(0);
      expect(startIndex).toBeGreaterThan(copyIndex);
      state.calls.length = 0;
      const nextRuntime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "next-owner-session",
        resolveWorkload: () =>
          Effect.succeed({ bootstrap: { source: "/tmp/main.ts", destination: "/root" } }),
      });
      yield* nextRuntime.start(key, workload());
      expect(state.calls.some((call) => call.startsWith("copy:"))).toBe(true);
    }),
  );

  it.live("removes a newly-created container when bootstrap copy fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
        copyFailure: new ContainerCommandError({
          operation: "copy-container",
          message: "bootstrap copy failed",
        }),
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
        resolveWorkload: () =>
          Effect.succeed({ bootstrap: { source: "/tmp/main.ts", destination: "/root" } }),
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.calls.some((call) => call.startsWith("copy:"))).toBe(false);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("start:"))).toBe(false);
      expect(state.resources.some((resource) => resource.kind === "workload")).toBe(false);
    }),
  );

  it.live("serializes concurrent starts and does not mutate when image inspection fails", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: false,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
      });
      yield* Effect.all([runtime.start(key, workload()), runtime.start(key, workload())], {
        concurrency: 2,
      });
      expect(state.calls.filter((call) => call === "create-network")).toHaveLength(1);
      expect(state.calls.filter((call) => call === "create-container")).toHaveLength(1);

      const failedState: FakeContainerState = {
        resources: [],
        imagePresent: false,
        calls: [],
        createdSpecs: [],
        nextId: 1,
        inspectImageFailure: new ContainerCommandError({
          operation: "inspect-image",
          message: "registry unavailable",
        }),
      };
      const failedRuntime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(failedState),
        ownerSessionId: "owner-session",
      });
      const failed = yield* failedRuntime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(failedState.calls).not.toContain("pull-image");
      expect(failedState.calls).not.toContain("create-network");
      expect(failedState.calls).not.toContain("create-container");
    }),
  );

  it.live("preserves container engine identity for runtime operations after preflight", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
        inspectImageFailure: new ContainerCommandError({
          operation: "inspect-image",
          message: "daemon rejected image inspection",
        }),
      };
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "owner-session",
      });
      const result = yield* runtime.start(key, workload()).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      const failure = errorOf(result);
      expect(failure).toBeInstanceOf(RuntimeDriverError);
      expect(failure?.cause).toBeInstanceOf(ContainerEngineError);
      expect(failure?.cause).toMatchObject({ message: "daemon rejected image inspection" });
    }),
  );

  it.live("reports container engine identity when a log follower fails before readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-container-follower-" });
        const testStackId = yield* deriveStackId({
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
          branchContext: "ordinary-workspace",
          localProjectKey: ".",
          stackName: "container-follower",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        yield* store.initialize(testStackId, {
          format: "supabase-stack-state-v1",
          identity: {
            stackId: testStackId,
            projectRoot: root,
            checkoutRoot: root,
            workspaceId: root,
            checkoutId: root,
            branchContext: "ordinary-workspace",
            localProjectKey: ".",
            stackName: "container-follower",
          },
          runtime: { kind: "container", engine: "docker" },
          desiredLifecycle: "unconfigured",
          ports: [],
          privatePorts: [],
          secrets: {},
        });
        const state: FakeContainerState = {
          resources: [],
          imagePresent: true,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const engine: ContainerEngine = {
          ...fakeContainerEngine(state),
          waitContainer: () => Effect.never,
          streamLogs: () =>
            Stream.fail(
              new ContainerEngineProtocolError({
                operation: "logs",
                message: "follower disconnected before readiness",
              }),
            ),
        };
        const logStore = memoryLogStore([]);
        const driver = yield* makeContainerRuntime({
          engine,
          ownerSessionId: "owner-session",
          logStore,
          resolveWorkload: () => Effect.succeed({ waitForReadiness: () => Effect.never }),
        });
        const ingress: SupervisorIngress = {
          acquire: () =>
            Effect.succeed({
              assignments: {},
              privateAssignments: [],
              hostListeners: [],
              fresh: false,
              ownershipToken: Symbol(),
            }),
          open: () => Effect.void,
          close: Effect.void,
        };
        const runtime: SupervisorRuntime = {
          driver,
          preflight: () => Effect.void,
          activate: () => Effect.succeed({ host: "127.0.0.1", port: 9999 }),
          ingress,
          logStore,
        };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const supervisor = yield* makeSupervisor({
          stackId: testStackId,
          ownerSessionId: "owner-session",
          rpcRelease: "test-release",
          stateStore: store,
          context,
          runtime,
        });
        const result = yield* supervisor.start().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(ContainerEngineError);
            expect(failure.value.message).toContain("follower disconnected before readiness");
          }
        }
        yield* supervisor.shutdownIfIdle;
        yield* supervisor.shutdown;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
