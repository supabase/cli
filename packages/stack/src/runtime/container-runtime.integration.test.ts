import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import { StackIdSchema } from "../public/StackId.ts";
import {
  ContainerExecutableNotFoundError,
  ContainerCommandError,
  ContainerEngineProtocolError,
  makeControlledCommandRunner,
  makeProcessCommandRunner,
  selectContainerEngine,
  type ContainerProcessRequest,
  type ContainerCommandResult,
  type ContainerContainerSpec,
  type ContainerEngine,
  type ContainerNetworkSpec,
  type ContainerResource,
  type ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import { makeDockerEngine, serializeDockerCommand } from "./DockerEngine.ts";
import { makePodmanEngine, serializePodmanCommand } from "./PodmanEngine.ts";
import { makeContainerRuntime } from "./ContainerRuntime.ts";
import { RuntimeDriverError, type RuntimeWorkloadKey } from "./RuntimeDriver.ts";

const stackId = StackIdSchema.make("a".repeat(64));
const key: RuntimeWorkloadKey = {
  stackId,
  desiredGeneration: 7,
  workloadId: "database:database",
  specHash: "hash-7",
};

const containerArtifact: ContainerArtifact = {
  kind: "container",
  service: "database",
  image: "example/database:1",
};

const workload = (selected: PlannedWorkload["selected"] = containerArtifact): PlannedWorkload => ({
  id: key.workloadId,
  capability: key.workloadId.startsWith("functions:") ? "functions" : "database",
  dependencies: [],
  readiness: { mode: "tcp" },
  restart: { maxAttempts: 1, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", service: "database", release: "1" },
    container: containerArtifact,
  },
  selected,
  specHash: key.specHash,
});

const recoveryPlan = (workloads: ReadonlyArray<PlannedWorkload>): ExecutionPlan => ({
  runtime: { kind: "container", engine: "docker" },
  activation: {
    database: "eager",
    rest: "eager",
    auth: "eager",
    realtime: "eager",
    storage: "eager",
    functions: "eager",
    studio: "eager",
    mail: "eager",
    analytics: "eager",
    pooler: "eager",
  },
  startOrder: ["database"],
  stopOrder: ["database"],
  dependencies: {
    database: [],
    rest: [],
    auth: [],
    realtime: [],
    storage: [],
    functions: [],
    studio: [],
    mail: [],
    analytics: [],
    pooler: [],
  },
  routes: [],
  workloads,
});

const commandResult = (value: unknown): ContainerCommandResult => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  exitCode: 0,
});

interface FakeContainerState {
  resources: Array<ContainerResource>;
  imagePresent: boolean;
  calls: Array<string>;
  createdSpecs: Array<ContainerContainerSpec>;
  nextId: number;
  inspectImageFailure?: ContainerCommandError;
  copyFailure?: ContainerCommandError;
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

  it.live("selects explicit engines and only falls back on missing executable", () =>
    Effect.gen(function* () {
      const missing = makeControlledCommandRunner({
        run: () =>
          Effect.fail(
            new ContainerExecutableNotFoundError({
              executable: "docker",
              message: "docker executable was not found",
            }),
          ),
      });
      const podman = makeControlledCommandRunner({
        run: () => Effect.succeed(commandResult({ ok: true })),
      });
      const selected = yield* selectContainerEngine({
        preference: "auto",
        docker: makeDockerEngine({ runner: missing, platform: { os: "linux", desktop: false } }),
        podman: makePodmanEngine({ runner: podman, platform: { os: "linux", rootless: true } }),
      });
      expect(selected.kind).toBe("podman");
      const daemonFailure = makeControlledCommandRunner({
        run: () =>
          Effect.fail(
            new ContainerEngineProtocolError({ operation: "probe", message: "daemon unavailable" }),
          ),
      });
      const failure = yield* selectContainerEngine({
        preference: "auto",
        docker: makeDockerEngine({
          runner: daemonFailure,
          platform: { os: "linux", desktop: false },
        }),
        podman: makePodmanEngine({ runner: podman, platform: { os: "linux", rootless: true } }),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) {
        const error = Cause.findErrorOption(failure.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error))
          expect(error.value).not.toBeInstanceOf(ContainerExecutableNotFoundError);
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
        .start(key, workload({ kind: "native", service: "database", release: "1" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(called).toBe(false);
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
            desiredGeneration: 1,
            workloadId: "database:database",
            specHash: "hash",
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
                  ? `${dockerJsonRow(["container-id", "backend", stackId, "owner", "7", key.workloadId, key.specHash, "workload", "running"])}\n`
                  : request.args[0] === "network" && request.args[1] === "create"
                    ? "created-id\nsecond\n"
                    : request.args[0] === "network"
                      ? `${dockerJsonRow(["network-id", "private", stackId, "owner", "7", "network"])}\n`
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
          labels: { stackId, ownerSessionId: "owner", desiredGeneration: 7, role: "network" },
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
          desiredGeneration: 7,
          workloadId: "backend",
          specHash: key.specHash,
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
                    ? `container-id\tbackend\t${stackId}\towner\t7\t${key.workloadId}\t${key.specHash}\tworkload\trunning\n`
                    : request.args[0] === "network"
                      ? `network-id\tprivate\t${stackId}\towner\t7\tnetwork\n`
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

  it.live("adopts an exact running container and replaces only same-owner stale state", () =>
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
      state.calls.length = 0;
      yield* runtime.start(key, workload());
      expect(state.calls).not.toContain("inspect-image");
      expect(state.calls).not.toContain("create-container");
      expect(state.calls.some((call) => call.startsWith("start:"))).toBe(false);

      const staleKey = { ...key, specHash: "hash-new" };
      state.calls.length = 0;
      yield* runtime.start(staleKey, workload({ ...containerArtifact }));
      const stopIndex = state.calls.findIndex((call) => call.startsWith("stop:"));
      const removeIndex = state.calls.findIndex((call) => call.startsWith("remove:"));
      const createIndex = state.calls.indexOf("create-container");
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(removeIndex).toBeGreaterThan(stopIndex);
      expect(createIndex).toBeGreaterThan(removeIndex);
    }),
  );

  it.live("runs database bootstrap before reporting an adopted running container ready", () =>
    Effect.gen(function* () {
      const state: FakeContainerState = {
        resources: [
          {
            id: "adopted-database",
            name: "adopted-database",
            kind: "workload",
            state: "running",
            labels: {
              stackId: key.stackId,
              ownerSessionId: "previous-owner",
              desiredGeneration: key.desiredGeneration,
              workloadId: key.workloadId,
              specHash: key.specHash,
              role: "workload",
            },
          },
        ],
        imagePresent: true,
        calls: [],
        createdSpecs: [],
        nextId: 1,
      };
      const order: string[] = [];
      const runtime = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "new-owner",
        waitForReadiness: () => Effect.sync(() => order.push("readiness")),
        bootstrapDatabase: () => Effect.sync(() => order.push("bootstrap")),
      });
      const databaseWorkload = { ...workload(), bootstrap: "database" as const };
      const adopted = yield* runtime.recover({
        stackId: key.stackId,
        desiredGeneration: key.desiredGeneration,
        desiredLifecycle: "running",
        plan: recoveryPlan([databaseWorkload]),
      });
      expect(order).toEqual(["readiness", "bootstrap"]);
      expect(adopted).toEqual([{ ...key, state: "ready" }]);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    }),
  );

  it.live(
    "stops but does not remove an adopted database after bootstrap failure, then retries",
    () =>
      Effect.gen(function* () {
        const state: FakeContainerState = {
          resources: [
            {
              id: "adopted-database",
              name: "adopted-database",
              kind: "workload",
              state: "running",
              labels: {
                stackId: key.stackId,
                ownerSessionId: "previous-owner",
                desiredGeneration: key.desiredGeneration,
                workloadId: key.workloadId,
                specHash: key.specHash,
                role: "workload",
              },
            },
          ],
          imagePresent: true,
          calls: [],
          createdSpecs: [],
          nextId: 1,
        };
        const bootstrapError = new RuntimeDriverError({
          message: "recovered database bootstrap failed",
          stackId: key.stackId,
          workloadId: key.workloadId,
        });
        let attempts = 0;
        const runtime = yield* makeContainerRuntime({
          engine: fakeContainerEngine(state),
          ownerSessionId: "new-owner",
          bootstrapDatabase: () =>
            Effect.gen(function* () {
              attempts += 1;
              if (attempts === 1) return yield* Effect.fail(bootstrapError);
            }),
        });
        const databaseWorkload = { ...workload(), bootstrap: "database" as const };
        const failed = yield* runtime
          .recover({
            stackId: key.stackId,
            desiredGeneration: key.desiredGeneration,
            desiredLifecycle: "running",
            plan: recoveryPlan([databaseWorkload]),
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(state.resources.find((resource) => resource.id === "adopted-database")?.state).toBe(
          "stopped",
        );
        expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
        expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(false);
        const retry = yield* runtime.start(key, databaseWorkload);
        expect(retry.state).toBe("ready");
        expect(attempts).toBe(2);
        expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(false);
      }),
  );

  it.live("leaves foreign and sanitized-name collisions untouched", () =>
    Effect.gen(function* () {
      const foreignStackId = StackIdSchema.make("c".repeat(64));
      const foreignKey = { ...key, stackId: foreignStackId, workloadId: "api:api" };
      const foreignName = `supabase-${stackId.slice(0, 16)}-${foreignKey.desiredGeneration}-api-api-workload`;
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
              desiredGeneration: foreignKey.desiredGeneration,
              workloadId: foreignKey.workloadId,
              specHash: foreignKey.specHash,
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

      const firstKey = { ...key, workloadId: "foo/bar", specHash: "first" };
      const secondKey = { ...key, workloadId: "foo?bar", specHash: "second" };
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
        yield* runtime.start(key, workload());
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
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      order.length = 0;

      const databaseWorkload = { ...workload(), bootstrap: "database" as const };
      const databaseReady = yield* runtime.start(
        { ...key, specHash: "database-bootstrap" },
        databaseWorkload,
      );
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

  it.live("does not remove an adopted running database container on bootstrap failure", () =>
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
        message: "adopted database bootstrap failed",
        stackId: key.stackId,
        workloadId: key.workloadId,
      });
      let attempts = 0;
      const adopted = yield* makeContainerRuntime({
        engine: fakeContainerEngine(state),
        ownerSessionId: "new-owner",
        bootstrapDatabase: () =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) return yield* Effect.fail(bootstrapError);
          }),
      });
      const result = yield* adopted
        .start(key, { ...workload(), bootstrap: "database" as const })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.calls.some((call) => call.startsWith("stop:"))).toBe(true);
      expect(state.calls.some((call) => call.startsWith("remove:"))).toBe(false);
      expect(state.resources.find((resource) => resource.kind === "workload")?.state).toBe(
        "stopped",
      );
      const retry = yield* adopted.start(key, { ...workload(), bootstrap: "database" as const });
      expect(retry.state).toBe("ready");
      expect(attempts).toBe(2);
    }),
  );

  it.live(
    "copies a new functions bootstrap before starting and never copies an adopted container",
    () =>
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
        yield* runtime.start(key, workload());
        expect(state.calls.some((call) => call.startsWith("copy:"))).toBe(false);
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
});
