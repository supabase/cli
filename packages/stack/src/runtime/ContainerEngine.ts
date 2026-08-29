import { Data, Effect, Predicate, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as ChildProcessSpawnerService from "effect/unstable/process/ChildProcessSpawner";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import type { StackId } from "../public/StackId.ts";

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
export class ContainerExecutableNotFoundError extends Data.TaggedError(
  "ContainerExecutableNotFoundError",
)<{ readonly executable: string; readonly message: string }> {}
export class ContainerRoutingUnsupportedError extends Data.TaggedError(
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

export type ContainerResourceRole = "network" | "volume" | "workload" | "gateway";
interface ContainerIdentityLabels {
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly desiredGeneration: number;
}
export interface ContainerNetworkLabels extends ContainerIdentityLabels {
  readonly role: "network";
}
export interface ContainerWorkloadLabels extends ContainerIdentityLabels {
  readonly workloadId: string;
  readonly specHash: string;
  readonly role: "workload" | "gateway";
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
export interface ContainerPortPublication {
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
  readonly role: "workload" | "gateway";
  readonly command?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
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
  | { readonly operation: "start-container"; readonly id: string }
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
export interface ContainerCommandRunner {
  readonly executable: string;
  readonly run: (
    request: ContainerProcessRequest,
  ) => Effect.Effect<ContainerCommandResult, ContainerEngineFailure>;
}
export interface ControlledCommandRunnerOptions {
  readonly executable?: string;
  readonly run: (
    request: ContainerProcessRequest,
  ) => Effect.Effect<ContainerCommandResult, ContainerEngineFailure>;
}
export const makeControlledCommandRunner = (
  options: ControlledCommandRunnerOptions,
): ContainerCommandRunner => ({
  executable: options.executable ?? "controlled-container-engine",
  run: options.run,
});

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
    return { executable: options.executable, run };
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
}
export interface ContainerEngineOptions {
  readonly kind: ContainerEngineKind;
  readonly runner: ContainerCommandRunner;
  readonly platform: ContainerPlatform;
  readonly codecs: ContainerEngineCodecs;
}
export interface ContainerEngine {
  readonly kind: ContainerEngineKind;
  readonly executable: string;
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
  readonly startContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly stopContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
  readonly removeContainer: (id: string) => Effect.Effect<void, ContainerEngineFailure>;
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
    executable: options.runner.executable,
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
    createContainer: (spec) =>
      spec.role === "workload" && (spec.publications.length > 0 || spec.hostRoute !== undefined)
        ? Effect.fail(
            new ContainerEngineProtocolError({
              operation: "create-container",
              message: "Only the gateway container may publish host ports or host routes",
            }),
          )
        : check("create-container", { operation: "create-container", spec }).pipe(
            Effect.flatMap((result) =>
              options.codecs.decodeCreate("create-container", result, spec, spec.role),
            ),
          ),
    startContainer: (id) => noResult("start-container", { operation: "start-container", id }),
    stopContainer: (id) => noResult("stop-container", { operation: "stop-container", id }),
    removeContainer: (id) => noResult("remove-container", { operation: "remove-container", id }),
  };
};
export interface SelectContainerEngineOptions {
  readonly preference: "auto" | ContainerEngineKind;
  readonly docker: ContainerEngine;
  readonly podman: ContainerEngine;
}
export const selectContainerEngine = (
  options: SelectContainerEngineOptions,
): Effect.Effect<ContainerEngine, ContainerEngineFailure> => {
  const explicit =
    options.preference === "docker"
      ? options.docker
      : options.preference === "podman"
        ? options.podman
        : undefined;
  if (explicit !== undefined) return explicit.probe.pipe(Effect.as(explicit));
  return options.docker.probe.pipe(
    Effect.as(options.docker),
    Effect.catchTag("ContainerExecutableNotFoundError", () =>
      options.podman.probe.pipe(Effect.as(options.podman)),
    ),
  );
};
