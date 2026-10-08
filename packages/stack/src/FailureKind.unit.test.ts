import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, PlatformError } from "effect";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { ArtifactError } from "./Artifacts.ts";
import { failureKind, type StackFailureKind } from "./FailureKind.ts";
import { HostProcessError } from "./HostProcess.ts";
import { OrchestratorError } from "./Orchestrator.ts";
import { PortError } from "./Ports.ts";
import { StackError } from "./Rpc.ts";
import { ContainerError } from "./runtime/Container.ts";
import { NativeProcessError } from "./runtime/NativeProcess.ts";
import { ArtifactIntegrityError, PreparationError } from "./preparation/Errors.ts";
import { ServiceError, ServiceLaunchError, type RuntimeSession } from "./Service.ts";
import { StackHostError } from "./StackHost.ts";
import { LeaseHeldError, NamespaceError } from "./StackNamespace.ts";
import { SupabaseCompositionError } from "./composition/Supabase.ts";

const fileFailure = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "writeFile",
  pathOrDescriptor: "/tmp/stack",
});
const runtime: RuntimeSession = {
  health: Effect.void,
  exit: Effect.succeed(Exit.void),
  stop: Effect.void,
  remove: Effect.void,
};
const cyclic: { cause?: unknown } = {};
cyclic.cause = cyclic;

const cases: ReadonlyArray<readonly [string, unknown, StackFailureKind | undefined]> = [
  [
    "a failed pull as image-pull",
    new ServiceError({
      operation: "prepare",
      message: "pull access denied",
      cause: new ContainerError({ operation: "pull", message: "pull access denied" }),
    }),
    "image-pull",
  ],
  [
    "a pull against an unreachable engine as engine-unavailable",
    new ContainerError({
      operation: "pull",
      message: "Cannot connect to the Docker daemon",
      kind: "engine-unavailable",
    }),
    "engine-unavailable",
  ],
  [
    "a wrapped container start that lost its engine-chosen host port as port-allocation",
    new ContainerError({
      operation: "create",
      message: "port is already allocated",
      cause: new ContainerError({
        operation: "start",
        message: "port is already allocated",
        kind: "port-allocation",
      }),
    }),
    "port-allocation",
  ],
  [
    "an engine command timeout as engine-timeout",
    new ContainerError({ operation: "ps", message: "timed out", cause: new Cause.TimeoutError() }),
    "engine-timeout",
  ],
  [
    "a pull that hit its download deadline as image-pull",
    new ContainerError({
      operation: "pull",
      message: "timed out",
      cause: new Cause.TimeoutError(),
    }),
    "image-pull",
  ],
  [
    "any other engine failure as engine-command",
    new ContainerError({ operation: "rm", message: "removal failed" }),
    "engine-command",
  ],
  [
    "a readiness timeout as health-timeout",
    new ServiceError({
      operation: "health",
      message: "Service health timed out",
      cause: new Cause.TimeoutError(),
    }),
    "health-timeout",
  ],
  [
    "a launch timeout as timeout",
    new ServiceError({
      operation: "launch",
      message: "timed out",
      cause: new Cause.TimeoutError(),
    }),
    "timeout",
  ],
  [
    "a readiness failure without a typed cause as health-check",
    new ServiceError({ operation: "health", message: "HTTP 503" }),
    "health-check",
  ],
  [
    "a native port reservation failure as port-allocation",
    new ServiceError({
      operation: "launch",
      message: "No native service port is available",
      cause: new PortError({ key: "db", message: "No native service port is available" }),
    }),
    "port-allocation",
  ],
  [
    "a taken port the caller requested by number as port-conflict",
    new ServiceError({
      operation: "launch",
      message: "Port 54321 is already in use",
      cause: new PortError({ key: "db", message: "in use", kind: "port-conflict" }),
    }),
    "port-conflict",
  ],
  [
    "a native launch failure as process-spawn",
    new ServiceError({
      operation: "launch",
      message: "ENOENT",
      cause: new NativeProcessError({ message: "ENOENT" }),
    }),
    "process-spawn",
  ],
  [
    "a native stop failure as process-stop",
    new ServiceError({
      operation: "stop",
      message: "kill failed",
      cause: new NativeProcessError({ message: "kill failed" }),
    }),
    "process-stop",
  ],
  [
    "a launch failure that kept its runtime by its failure",
    new ServiceLaunchError({
      failure: new ServiceError({ operation: "exit", message: "Process exited with 1" }),
      runtime,
    }),
    "process-exit",
  ],
  [
    "a checksum mismatch below artifact preparation as artifact-integrity",
    new ServiceError({
      operation: "prepare",
      message: "Unable to prepare auth artifact",
      cause: new ArtifactError({
        message: "Unable to prepare auth artifact",
        cause: new PreparationError({
          message: "download failed",
          cause: new ArtifactIntegrityError({ message: "checksum mismatch" }),
        }),
      }),
    }),
    "artifact-integrity",
  ],
  [
    "a local cache permission failure inside artifact preparation as filesystem-permission",
    new ArtifactError({ message: "Unable to prepare auth artifact", cause: fileFailure }),
    "filesystem-permission",
  ],
  [
    "a permission failure with no enclosing domain as filesystem-permission",
    new ServiceError({ operation: "launch", message: "denied", cause: fileFailure }),
    "filesystem-permission",
  ],
  [
    "a non-permission file failure as filesystem",
    new ServiceError({
      operation: "launch",
      message: "exists",
      cause: PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: "/tmp/stack",
      }),
    }),
    "filesystem",
  ],
  [
    "a state file failure as state",
    new NamespaceError({ operation: "read", message: "denied", cause: fileFailure }),
    "state",
  ],
  [
    "a live owner holding the stack lease as lease-held",
    new LeaseHeldError({ stackId: "abc", message: "held" }),
    "lease-held",
  ],
  [
    "an operational failure inside composition as its own kind",
    new SupabaseCompositionError({
      message: "pull access denied",
      cause: new ContainerError({ operation: "pull", message: "pull access denied" }),
    }),
    "image-pull",
  ],
  [
    "an invalid composition as configuration",
    new SupabaseCompositionError({ message: "Duplicate service kind auth" }),
    "configuration",
  ],
  [
    "an owner that kept running after shutdown as owner-exit",
    new HostProcessError({
      operation: "shutdown-exit",
      message: "still running",
      reason: "owner-exit-pending",
    }),
    "owner-exit",
  ],
  [
    "an unreachable owner control endpoint as owner-connection",
    new HostProcessError({
      operation: "connect",
      message: "Timed out connecting",
      reason: "connection-failure",
    }),
    "owner-connection",
  ],
  [
    "an owner startup failure the owner classified by that kind",
    new HostProcessError({ operation: "startup", message: "failed", kind: "engine-unavailable" }),
    "engine-unavailable",
  ],
  [
    "an unclassified owner startup failure as owner-startup",
    new HostProcessError({ operation: "startup", message: "Owner exited before reporting" }),
    "owner-startup",
  ],
  [
    "a held stack lease as lease-held",
    new StackHostError({ operation: "lease", message: "held", reason: "lease-held" }),
    "lease-held",
  ],
  [
    "an RPC transport failure as owner-connection",
    new RpcClientError({ reason: new RpcClientDefect({ message: "closed", cause: undefined }) }),
    "owner-connection",
  ],
  [
    "a stack error by the kind it carries",
    new StackError({ operation: "start", message: "failed", kind: "image-pull" }),
    "image-pull",
  ],
  [
    "a stack error with an unknown wire kind by its reason",
    new StackError({
      operation: "start",
      message: "failed",
      kind: "from-a-newer-release",
      reason: "runtime-unavailable",
    }),
    "engine-unavailable",
  ],
  [
    "a composition failure by its first classified outcome",
    new OrchestratorError({
      operation: "start",
      message: "Composition start had failures",
      outcomes: [
        {
          id: "rest",
          result: Exit.fail(new OrchestratorError({ operation: "start", message: "Blocked" })),
        },
        { id: "db", result: Exit.fail(new ServiceError({ operation: "exit", message: "exit 1" })) },
      ],
    }),
    "process-exit",
  ],
  [
    "a defect in a cause",
    Cause.die(new PortError({ key: "api", message: "in use" })),
    "port-allocation",
  ],
  [
    "a cyclic cause chain by the enclosing operation",
    new ServiceError({ operation: "exit", message: "exit 1", cause: cyclic }),
    "process-exit",
  ],
];

describe("failureKind", () => {
  it.each(cases)("classifies %s", (_, failure, expected) => {
    expect(failureKind(failure)).toBe(expected);
  });
});
