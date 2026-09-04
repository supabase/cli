import { Data, Effect, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as ChildProcessSpawnerService from "effect/unstable/process/ChildProcessSpawner";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { NetworkPortSchema } from "../public/Status.ts";

export type ContainerEngineKind = "docker" | "podman";
export interface ContainerPlatform {
  readonly os: "linux" | "darwin" | "windows";
  readonly desktop?: boolean;
  readonly rootless?: boolean;
  readonly remote?: boolean;
}
export interface ContainerHostRoute {
  readonly host: string;
  readonly gateway?: string;
}
class ContainerExecutableNotFoundError extends Data.TaggedError(
  "ContainerExecutableNotFoundError",
)<{ readonly executable: string; readonly message: string }> {}
class ContainerRoutingUnsupportedError extends Data.TaggedError(
  "ContainerRoutingUnsupportedError",
)<{ readonly engine: ContainerEngineKind; readonly message: string }> {}
export class ContainerEngineProtocolError extends Data.TaggedError("ContainerEngineProtocolError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
export class ContainerCommandError extends Data.TaggedError("ContainerCommandError")<{
  readonly operation: string;
  readonly message: string;
}> {}
export type ContainerEngineFailure =
  | ContainerExecutableNotFoundError
  | ContainerRoutingUnsupportedError
  | ContainerEngineProtocolError
  | ContainerCommandError;

export type ContainerResourceRole = "network" | "volume" | "workload";
interface ContainerIdentityLabels {
  readonly stackId: StackId;
  readonly ownerSessionId: string;
}
export interface ContainerNetworkLabels extends ContainerIdentityLabels {
  readonly role: "network";
}
export interface ContainerWorkloadLabels extends ContainerIdentityLabels {
  readonly workloadId: string;
  readonly startup?: boolean;
  readonly role: "workload";
}
export interface ContainerVolumeLabels {
  readonly stackId: StackId;
  readonly workloadId: string;
  readonly role: "volume";
}
export type ContainerLabels =
  | ContainerNetworkLabels
  | ContainerWorkloadLabels
  | ContainerVolumeLabels;

const CONTAINER_LABEL_PREFIX = "com.supabase.stack";
export const CONTAINER_LABEL_KEYS = {
  stackId: `${CONTAINER_LABEL_PREFIX}.stackId`,
  ownerSessionId: `${CONTAINER_LABEL_PREFIX}.ownerSessionId`,
  workloadId: `${CONTAINER_LABEL_PREFIX}.workloadId`,
  startup: `${CONTAINER_LABEL_PREFIX}.startup`,
  role: `${CONTAINER_LABEL_PREFIX}.role`,
};

/** Shapes byte-identical label argv for Docker and Podman. */
export const containerLabels = (value: ContainerLabels): ReadonlyArray<string> => {
  const pairs: ReadonlyArray<readonly [string, string]> =
    value.role === "network"
      ? [
          ["stackId", value.stackId],
          ["ownerSessionId", value.ownerSessionId],
          ["role", value.role],
        ]
      : value.role === "volume"
        ? [
            ["stackId", value.stackId],
            ["workloadId", value.workloadId],
            ["role", value.role],
          ]
        : [
            ["stackId", value.stackId],
            ["ownerSessionId", value.ownerSessionId],
            ["workloadId", value.workloadId],
            ["startup", value.startup === true ? "true" : "false"],
            ["role", value.role],
          ];
  return pairs.flatMap(([key, label]) => ["--label", `${CONTAINER_LABEL_PREFIX}.${key}=${label}`]);
};
export interface ContainerResource {
  readonly id: string;
  readonly name: string;
  readonly kind: ContainerResourceRole;
  readonly labels: ContainerLabels;
  readonly state?: "created" | "running" | "stopped";
}
export interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}
export interface ContainerVolumeMount {
  readonly volume: string;
  readonly target: string;
  readonly readOnly: boolean;
}
export interface ContainerStartupProcess {
  readonly entrypoint: string;
  readonly command: ReadonlyArray<string>;
}
interface ContainerPortPublication {
  readonly address: "127.0.0.1";
  readonly hostPort: number;
  readonly containerPort: number;
}
export interface ContainerNetworkSpec {
  readonly name: string;
  readonly labels: ContainerNetworkLabels;
}
export interface ContainerVolumeSpec {
  readonly name: string;
  readonly labels: ContainerVolumeLabels;
}
export interface ContainerContainerSpec {
  readonly name: string;
  readonly image: ContainerArtifact["image"];
  readonly labels: ContainerWorkloadLabels;
  readonly network: string;
  readonly mounts: ReadonlyArray<ContainerMount>;
  readonly volumeMounts: ReadonlyArray<ContainerVolumeMount>;
  readonly publications: ReadonlyArray<ContainerPortPublication>;
  readonly hostRoute?: ContainerHostRoute;
  readonly role: "workload";
  /** Optional image entrypoint override used by service-owned init processes. */
  readonly entrypoint?: string;
  readonly command?: ReadonlyArray<string>;
  /** Path to an owned 0600 env file. Secret values must never be argv. */
  readonly envFile?: string;
  readonly networkAliases?: ReadonlyArray<string>;
}

export type ContainerCommand =
  | { readonly operation: "probe" }
  | { readonly operation: "inspect-image"; readonly image: string }
  | { readonly operation: "pull-image"; readonly image: string }
  | { readonly operation: "inspect-containers"; readonly stackId: StackId }
  | { readonly operation: "inspect-networks"; readonly stackId: StackId }
  | { readonly operation: "inspect-volumes"; readonly stackId: StackId }
  | { readonly operation: "create-network"; readonly spec: ContainerNetworkSpec }
  | { readonly operation: "remove-network"; readonly id: string }
  | { readonly operation: "create-volume"; readonly spec: ContainerVolumeSpec }
  | { readonly operation: "remove-volume"; readonly id: string }
  | { readonly operation: "create-container"; readonly spec: ContainerContainerSpec }
  | {
      readonly operation: "copy-container";
      readonly id: string;
      readonly source: string;
      readonly destination: string;
    }
  | { readonly operation: "start-container"; readonly id: string }
  | { readonly operation: "wait-container"; readonly id: string }
  | { readonly operation: "stop-container"; readonly id: string }
  | { readonly operation: "remove-container"; readonly id: string };
export interface ContainerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
export interface ContainerProcessRequest {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}
interface ContainerProcessOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}
export interface ContainerLogLine {
  readonly stream: "stdout" | "stderr";
  readonly message: string;
}
export interface ContainerLogOptions {
  /** Number of historical lines to replay before following. `all` is the default. */
  readonly tail?: "all" | 0;
}
export interface ContainerCommandRunner {
  readonly run: (
    request: ContainerProcessRequest,
  ) => Effect.Effect<ContainerCommandResult, ContainerEngineFailure>;
  /** Follows one exact process's stdout/stderr until it exits. */
  readonly stream?: (
    request: ContainerProcessRequest,
  ) => Stream.Stream<ContainerProcessOutputChunk, ContainerEngineFailure>;
}
export interface ProcessCommandRunnerOptions {
  readonly executable: string;
  readonly baseArgs?: ReadonlyArray<string>;
  readonly maxOutputBytes?: number;
}
const boundedOutput = (
  stream: Stream.Stream<Uint8Array, unknown, never>,
  maxBytes: number,
): Effect.Effect<string, ContainerEngineProtocolError> =>
  Stream.runFoldEffect(
    stream.pipe(
      Stream.mapError(
        (cause) =>
          new ContainerEngineProtocolError({
            operation: "process-output",
            message: "Container engine output stream failed",
            cause,
          }),
      ),
    ),
    () => new Uint8Array(),
    (current: Uint8Array, chunk: Uint8Array) => {
      const remaining = Math.max(0, maxBytes - current.length);
      if (chunk.length > remaining)
        return Effect.fail(
          new ContainerEngineProtocolError({
            operation: "process-output",
            message: "Container engine output exceeded the configured limit",
          }),
        );
      const result = new Uint8Array(current.length + chunk.length);
      result.set(current);
      result.set(chunk, current.length);
      return Effect.succeed(result);
    },
  ).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));
export const makeProcessCommandRunner = (
  options: ProcessCommandRunnerOptions,
): Effect.Effect<
  ContainerCommandRunner,
  ContainerEngineFailure,
  ChildProcessSpawnerService.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const run = (
      request: ContainerProcessRequest,
    ): Effect.Effect<ContainerCommandResult, ContainerEngineFailure> => {
      const stdin =
        request.stdin === undefined
          ? "ignore"
          : {
              stream: Stream.succeed(new TextEncoder().encode(request.stdin)),
              endOnDone: true,
            };
      return Effect.scoped(
        Effect.acquireUseRelease(
          ChildProcess.make(options.executable, [...(options.baseArgs ?? []), ...request.args], {
            stdin,
            stdout: "pipe",
            stderr: "pipe",
            ...(request.env === undefined ? {} : { env: request.env }),
            extendEnv: true,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          (handle) =>
            Effect.gen(function* () {
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [
                  boundedOutput(handle.stdout, maxOutputBytes),
                  boundedOutput(handle.stderr, maxOutputBytes),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return { stdout, stderr, exitCode: Number(exitCode) };
            }),
          (handle) => {
            const terminate = (signal: "SIGTERM" | "SIGKILL") =>
              Effect.gen(function* () {
                if (!(yield* handle.isRunning)) return;
                yield* handle.kill({ killSignal: signal });
              });
            return Effect.timeoutOrElse(terminate("SIGTERM").pipe(Effect.interruptible), {
              duration: "2 seconds",
              orElse: () => terminate("SIGKILL"),
            });
          },
        ),
      ).pipe(
        Effect.mapError((error) =>
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          Predicate.isTagged(error.reason, "NotFound")
            ? new ContainerExecutableNotFoundError({
                executable: options.executable,
                message: `${options.executable} executable was not found`,
              })
            : new ContainerEngineProtocolError({
                operation: request.args[0] ?? "command",
                message: "Container engine process failed",
                cause: error,
              }),
        ),
      );
    };
    const stream = (
      request: ContainerProcessRequest,
    ): Stream.Stream<ContainerProcessOutputChunk, ContainerEngineFailure> =>
      Stream.scoped(
        Stream.unwrap(
          ChildProcess.make(options.executable, [...(options.baseArgs ?? []), ...request.args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            ...(request.env === undefined ? {} : { env: request.env }),
            extendEnv: true,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              () =>
                new ContainerEngineProtocolError({
                  operation: request.args[0] ?? "stream",
                  message: "Container engine log follower failed to start",
                }),
            ),
            Effect.map((handle) => {
              const mapOutput = (
                output: Stream.Stream<Uint8Array, unknown>,
                streamName: "stdout" | "stderr",
              ): Stream.Stream<ContainerProcessOutputChunk, ContainerEngineFailure> =>
                output.pipe(
                  Stream.map((bytes) => ({ stream: streamName, bytes })),
                  Stream.mapError(
                    () =>
                      new ContainerEngineProtocolError({
                        operation: request.args[0] ?? "stream",
                        message: "Container engine log follower output failed",
                      }),
                  ),
                );
              const output = Stream.merge(
                mapOutput(handle.stdout, "stdout"),
                mapOutput(handle.stderr, "stderr"),
              );
              const verifyExit = Stream.fromEffect(
                handle.exitCode.pipe(
                  Effect.mapError(
                    () =>
                      new ContainerEngineProtocolError({
                        operation: request.args[0] ?? "stream",
                        message: "Container engine log follower exit status failed",
                      }),
                  ),
                  Effect.flatMap((code) =>
                    Number(code) === 0
                      ? Effect.void
                      : Effect.fail(
                          new ContainerCommandError({
                            operation: request.args[0] ?? "stream",
                            message: `Container engine log follower exited (${String(code)})`,
                          }),
                        ),
                  ),
                ),
              ).pipe(Stream.flatMap(() => Stream.empty));
              return output.pipe(Stream.concat(verifyExit));
            }),
          ),
        ),
      );
    return { run, stream };
  });

export interface ContainerEngineCodecs {
  readonly serialize: (command: ContainerCommand) => ContainerProcessRequest;
  readonly decodeProbe: (
    result: ContainerCommandResult,
  ) => Effect.Effect<void, ContainerEngineFailure>;
  readonly decodeImage: (
    result: ContainerCommandResult,
  ) => Effect.Effect<Readonly<{ readonly present: boolean }>, ContainerEngineFailure>;
  readonly decodeContainers: (
    result: ContainerCommandResult,
  ) => Effect.Effect<ReadonlyArray<ContainerResource>, ContainerEngineFailure>;
  readonly decodeNetworks: (
    result: ContainerCommandResult,
  ) => Effect.Effect<ReadonlyArray<ContainerResource>, ContainerEngineFailure>;
  readonly decodeVolumes: (
    result: ContainerCommandResult,
  ) => Effect.Effect<ReadonlyArray<ContainerResource>, ContainerEngineFailure>;
  readonly decodeCreate: <R extends ContainerResourceRole>(
    operation: string,
    result: ContainerCommandResult,
    spec: { readonly name: string; readonly labels: ContainerLabels },
    kind: R,
  ) => Effect.Effect<ContainerResource, ContainerEngineFailure>;
  readonly decodeWait: (
    result: ContainerCommandResult,
  ) => Effect.Effect<number, ContainerEngineFailure>;
  readonly serializeLogs: (
    id: string,
    options: ContainerLogOptions | undefined,
  ) => ContainerProcessRequest;
}

export const makeContainerEngineCodecs = (options: {
  readonly engineName: "Docker" | "Podman";
  readonly scalarFormat: "json" | "raw";
  readonly serialize: ContainerEngineCodecs["serialize"];
  readonly serializeLogs: ContainerEngineCodecs["serializeLogs"];
}): ContainerEngineCodecs => {
  const protocol = (operation: string, cause?: unknown): ContainerEngineProtocolError =>
    new ContainerEngineProtocolError({
      operation,
      message: `${operation} returned an invalid ${options.engineName} response`,
      ...(cause === undefined ? {} : { cause }),
    });
  const lines = (raw: string): ReadonlyArray<string> =>
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const scalar = (
    operation: string,
    raw: string,
  ): Effect.Effect<string, ContainerEngineFailure> => {
    if (options.scalarFormat === "raw") {
      const value = raw.trim();
      return value.length > 0 && !/\\t|\t/.test(value)
        ? Effect.succeed(value)
        : Effect.fail(protocol(operation));
    }
    return Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(raw).pipe(
      Effect.mapError((cause) => protocol(operation, cause)),
      Effect.flatMap((value) =>
        typeof value === "string" && value.length > 0
          ? Effect.succeed(value)
          : Effect.fail(protocol(operation)),
      ),
    );
  };
  const fields = (operation: string, line: string, count: number) => {
    const values = line.split(/\\t|\t/);
    if (values.length !== count) return Effect.fail(protocol(operation));
    return options.scalarFormat === "json"
      ? Effect.forEach(values, (value) => scalar(operation, value))
      : Effect.succeed(values);
  };
  const decodeIdentity = (operation: string, stack: string | undefined) =>
    stack === undefined
      ? Effect.fail(protocol(operation))
      : Schema.decodeEffect(StackIdSchema)(stack).pipe(
          Effect.mapError((error) => protocol(operation, error)),
        );
  const networkLabels = (operation: string, values: ReadonlyArray<string>) => {
    const [stack, owner, role] = values;
    if (owner === undefined || role !== "network") return Effect.fail(protocol(operation));
    return decodeIdentity(operation, stack).pipe(
      Effect.map((stackId) => ({ stackId, ownerSessionId: owner, role: "network" as const })),
    );
  };
  const workloadLabels = (operation: string, values: ReadonlyArray<string>) => {
    const [stack, owner, workload, startup, role] = values;
    if (owner === undefined || workload === undefined || role !== "workload")
      return Effect.fail(protocol(operation));
    return decodeIdentity(operation, stack).pipe(
      Effect.map((stackId) => ({
        stackId,
        ownerSessionId: owner,
        workloadId: workload,
        ...(startup === "true" ? { startup: true } : {}),
        role: "workload" as const,
      })),
    );
  };
  const decodeRows = <A>(
    operation: string,
    raw: string,
    count: number,
    decode: (values: ReadonlyArray<string>) => Effect.Effect<A, ContainerEngineFailure>,
  ) =>
    Effect.forEach(lines(raw), (line) =>
      fields(operation, line, count).pipe(Effect.flatMap(decode)),
    );
  const decodeContainers: ContainerEngineCodecs["decodeContainers"] = (result) =>
    decodeRows("inspect-containers", result.stdout, 8, (values) => {
      const [id, name, stack, owner, workload, startup, role, state] = values;
      if (
        id === undefined ||
        name === undefined ||
        stack === undefined ||
        owner === undefined ||
        workload === undefined ||
        role !== "workload" ||
        state === undefined
      )
        return Effect.fail(protocol("inspect-containers"));
      return workloadLabels("inspect-containers", [
        stack,
        owner,
        workload,
        startup ?? "",
        role,
      ]).pipe(
        Effect.map((labels): ContainerResource => ({
          id,
          name,
          kind: "workload",
          labels,
          state: state.includes("running") ? "running" : "stopped",
        })),
      );
    });
  const decodeNetworks: ContainerEngineCodecs["decodeNetworks"] = (result) =>
    decodeRows("inspect-networks", result.stdout, 5, (values) => {
      const [id, name, stack, owner, role] = values;
      if (id === undefined || name === undefined || role === undefined)
        return Effect.fail(protocol("inspect-networks"));
      return networkLabels("inspect-networks", [stack ?? "", owner ?? "", role]).pipe(
        Effect.map((labels): ContainerResource => ({ id, name, kind: "network", labels })),
      );
    });
  const decodeVolumes: ContainerEngineCodecs["decodeVolumes"] = (result) =>
    decodeRows("inspect-volumes", result.stdout, 4, (values) => {
      const [name, stack, workload, role] = values;
      if (name === undefined || stack === undefined || workload === undefined || role !== "volume")
        return Effect.fail(protocol("inspect-volumes"));
      return decodeIdentity("inspect-volumes", stack).pipe(
        Effect.map((stackId): ContainerResource => ({
          id: name,
          name,
          kind: "volume",
          labels: { stackId, workloadId: workload, role: "volume" },
        })),
      );
    });
  const decodeCreate: ContainerEngineCodecs["decodeCreate"] = (operation, result, spec, kind) => {
    const id = result.stdout.trim();
    return id.length > 0 && !/[\r\n]/.test(id)
      ? Effect.succeed({ id, name: spec.name, kind, labels: spec.labels, state: "created" })
      : Effect.fail(protocol(operation));
  };
  const decodeWait: ContainerEngineCodecs["decodeWait"] = (result) => {
    const values = lines(result.stdout);
    const value = values[0];
    if (values.length !== 1 || value === undefined || !/^\d+$/.test(value))
      return Effect.fail(protocol("wait-container"));
    const exitCode = Number(value);
    return Number.isSafeInteger(exitCode)
      ? Effect.succeed(exitCode)
      : Effect.fail(protocol("wait-container"));
  };
  return {
    serialize: options.serialize,
    serializeLogs: options.serializeLogs,
    decodeProbe: (result) => scalar("probe", result.stdout).pipe(Effect.asVoid),
    decodeImage: (result) =>
      Effect.forEach(lines(result.stdout), (line) => scalar("inspect-image", line)).pipe(
        Effect.map((values) => ({ present: values.length > 0 })),
      ),
    decodeContainers,
    decodeNetworks,
    decodeVolumes,
    decodeCreate,
    decodeWait,
  };
};
export interface ContainerEngineOptions {
  readonly kind: ContainerEngineKind;
  readonly runner: ContainerCommandRunner;
  readonly platform: ContainerPlatform;
  readonly codecs: ContainerEngineCodecs;
}
export interface ContainerEngine {
  readonly kind: ContainerEngineKind;
  readonly preflight: Effect.Effect<ContainerHostRoute, ContainerEngineFailure>;
  readonly probe: Effect.Effect<void, ContainerEngineFailure>;
  readonly inspectImage: (
    image: string,
  ) => Effect.Effect<Readonly<{ readonly present: boolean }>, ContainerEngineFailure>;
  readonly pullImage: (image: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly listResources: (
    stackId: StackId,
  ) => Effect.Effect<ReadonlyArray<ContainerResource>, ContainerEngineFailure>;
  readonly createNetwork: (
    spec: ContainerNetworkSpec,
  ) => Effect.Effect<ContainerResource, ContainerEngineFailure>;
  readonly removeNetwork: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly createVolume: (
    spec: ContainerVolumeSpec,
  ) => Effect.Effect<ContainerResource, ContainerEngineFailure>;
  readonly removeVolume: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly createContainer: (
    spec: ContainerContainerSpec,
  ) => Effect.Effect<ContainerResource, ContainerEngineFailure>;
  /** Copies an owner-created bootstrap path into a newly-created container. */
  readonly copyToContainer: (
    id: string,
    source: string,
    destination: string,
  ) => Effect.Effect<void, ContainerEngineFailure>;
  readonly startContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  /** Waits for one exact container and returns its process exit code. */
  readonly waitContainer: (id: string) => Effect.Effect<number, ContainerEngineFailure>;
  readonly stopContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly removeContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  /** Follows one exact container and emits complete stdout/stderr lines. */
  readonly streamLogs?: (
    id: string,
    options?: ContainerLogOptions,
  ) => Stream.Stream<ContainerLogLine, ContainerEngineFailure>;
}
export const makeContainerEngineCore = (options: ContainerEngineOptions): ContainerEngine => {
  const run = (command: ContainerCommand) => options.runner.run(options.codecs.serialize(command));
  const check = (operation: string, command: ContainerCommand) =>
    run(command).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new ContainerCommandError({
                operation,
                message: `Container engine command failed (${result.exitCode})`,
              }),
            ),
      ),
    );
  const noResult = (operation: string, command: ContainerCommand) =>
    check(operation, command).pipe(Effect.asVoid);
  const streamLogs = (
    id: string,
    logOptions?: ContainerLogOptions,
  ): Stream.Stream<ContainerLogLine, ContainerEngineFailure> => {
    const source = options.runner.stream;
    if (source === undefined)
      return Stream.fail(
        new ContainerEngineProtocolError({
          operation: "logs",
          message: "Container engine log streaming is unavailable",
        }),
      );
    interface LineState {
      readonly stdout: { readonly decoder: TextDecoder; remainder: string };
      readonly stderr: { readonly decoder: TextDecoder; remainder: string };
    }
    const stateFor = (): LineState => ({
      stdout: { decoder: new TextDecoder(), remainder: "" },
      stderr: { decoder: new TextDecoder(), remainder: "" },
    });
    const split = (
      state: LineState,
      chunk: ContainerProcessOutputChunk,
    ): ReadonlyArray<ContainerLogLine> => {
      const accumulator = state[chunk.stream];
      accumulator.remainder += accumulator.decoder.decode(chunk.bytes, { stream: true });
      const lines = accumulator.remainder.split(/\r?\n/);
      accumulator.remainder = lines.pop() ?? "";
      return lines.map((message) => ({ stream: chunk.stream, message }));
    };
    const flush = (state: LineState): ReadonlyArray<ContainerLogLine> =>
      (["stdout", "stderr"] as const).flatMap((streamName) => {
        const accumulator = state[streamName];
        accumulator.remainder += accumulator.decoder.decode();
        if (accumulator.remainder.length === 0) return [];
        const message = accumulator.remainder;
        accumulator.remainder = "";
        return [{ stream: streamName, message }];
      });
    return source(options.codecs.serializeLogs(id, logOptions)).pipe(
      Stream.mapAccum(stateFor, (state, chunk) => [state, split(state, chunk)] as const, {
        onHalt: flush,
      }),
    );
  };
  const preflight =
    options.kind === "docker"
      ? options.platform.remote === true
        ? Effect.fail(
            new ContainerRoutingUnsupportedError({
              engine: options.kind,
              message: "Docker remote daemon has no verified host route",
            }),
          )
        : Effect.succeed(
            options.platform.os === "linux" && options.platform.desktop !== true
              ? { host: "host.docker.internal", gateway: "host-gateway" }
              : { host: "host.docker.internal" },
          )
      : options.platform.remote === true || options.platform.os !== "linux"
        ? Effect.fail(
            new ContainerRoutingUnsupportedError({
              engine: options.kind,
              message: "Podman host route is unsupported on this platform",
            }),
          )
        : Effect.succeed({ host: "host.containers.internal" });
  return {
    kind: options.kind,
    preflight,
    probe: check("probe", { operation: "probe" }).pipe(Effect.flatMap(options.codecs.decodeProbe)),
    inspectImage: (image) =>
      check("inspect-image", { operation: "inspect-image", image }).pipe(
        Effect.flatMap(options.codecs.decodeImage),
      ),
    pullImage: (image) => noResult("pull-image", { operation: "pull-image", image }),
    listResources: (stackId) =>
      Effect.all([
        check("inspect-containers", { operation: "inspect-containers", stackId }).pipe(
          Effect.flatMap(options.codecs.decodeContainers),
        ),
        check("inspect-networks", { operation: "inspect-networks", stackId }).pipe(
          Effect.flatMap(options.codecs.decodeNetworks),
        ),
        check("inspect-volumes", { operation: "inspect-volumes", stackId }).pipe(
          Effect.flatMap(options.codecs.decodeVolumes),
        ),
      ]).pipe(
        Effect.map(([containers, networks, volumes]) => [...containers, ...networks, ...volumes]),
      ),
    createNetwork: (spec) =>
      check("create-network", { operation: "create-network", spec }).pipe(
        Effect.flatMap((result) =>
          options.codecs.decodeCreate("create-network", result, spec, "network"),
        ),
      ),
    removeNetwork: (id) => noResult("remove-network", { operation: "remove-network", id }),
    createVolume: (spec) =>
      check("create-volume", { operation: "create-volume", spec }).pipe(
        Effect.flatMap((result) =>
          options.codecs.decodeCreate("create-volume", result, spec, "volume"),
        ),
      ),
    removeVolume: (id) => noResult("remove-volume", { operation: "remove-volume", id }),
    createContainer: (spec) => {
      const invalidPublication = spec.publications.some(
        (publication) =>
          publication.address !== "127.0.0.1" ||
          !Schema.is(NetworkPortSchema)(publication.hostPort) ||
          !Schema.is(NetworkPortSchema)(publication.containerPort),
      );
      return invalidPublication
        ? Effect.fail(
            new ContainerEngineProtocolError({
              operation: "create-container",
              message: "Container publications must use valid loopback host ports",
            }),
          )
        : check("create-container", { operation: "create-container", spec }).pipe(
            Effect.flatMap((result) =>
              options.codecs.decodeCreate("create-container", result, spec, spec.role),
            ),
          );
    },
    copyToContainer: (id, source, destination) =>
      noResult("copy-container", { operation: "copy-container", id, source, destination }),
    startContainer: (id) => noResult("start-container", { operation: "start-container", id }),
    waitContainer: (id) =>
      check("wait-container", { operation: "wait-container", id }).pipe(
        Effect.flatMap(options.codecs.decodeWait),
      ),
    stopContainer: (id) => noResult("stop-container", { operation: "stop-container", id }),
    removeContainer: (id) => noResult("remove-container", { operation: "remove-container", id }),
    streamLogs,
  };
};
