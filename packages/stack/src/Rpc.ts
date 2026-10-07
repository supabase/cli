import { Cause, Exit, Option, Predicate, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ServiceCreation, ServiceCreationInput } from "./services/Catalog.ts";
import { snapshotScopes } from "./services/DatabaseSnapshot.ts";
import { causeMessage, CompositionConfig, OrchestratorError } from "./Orchestrator.ts";
import { CommandInvocation } from "./Commands.ts";
import { StackKeysInput } from "./StackNamespace.ts";
import { failureMessage } from "./internal/failure-message.ts";
import type { PortConflict } from "./Ports.ts";

const Outcome = Schema.Struct({
  id: Schema.String,
  succeeded: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

const ConflictHolder = Schema.Union([
  Schema.Struct({ stackId: Schema.String, stateRoot: Schema.String }),
  Schema.Literal("foreign"),
]);
const Conflict = Schema.Struct({
  port: Schema.Int,
  endpoint: Schema.String,
  holder: ConflictHolder,
});

/** A typed failure returned by the stack owner. */
export class StackError extends Schema.TaggedError<StackError>()("StackError", {
  operation: Schema.String,
  message: Schema.String,
  outcomes: Schema.optionalKey(Schema.Array(Outcome)),
  /**
   * Why the client could not use an owner: none serves the stack (`owner-unavailable`), one of
   * another release does (`release-mismatch`), or its container engine is unreachable
   * (`runtime-unavailable`).
   */
  reason: Schema.optionalKey(
    Schema.Literals(["owner-unavailable", "release-mismatch", "runtime-unavailable"]),
  ),
  /** The contested public port, when the failure is a port reservation conflict. */
  conflict: Schema.optionalKey(Conflict),
}) {}

const isHolder = (
  value: unknown,
): value is { readonly stackId: string; readonly stateRoot: string } =>
  Predicate.hasProperty(value, "stackId") &&
  typeof value.stackId === "string" &&
  Predicate.hasProperty(value, "stateRoot") &&
  typeof value.stateRoot === "string";

const isPortConflict = (value: unknown): value is PortConflict =>
  Predicate.hasProperty(value, "port") &&
  typeof value.port === "number" &&
  Predicate.hasProperty(value, "endpoint") &&
  typeof value.endpoint === "string" &&
  Predicate.hasProperty(value, "holder") &&
  (value.holder === "foreign" || isHolder(value.holder));

/** The first `conflict` found by walking a failure's `cause` chain, if any carries one. */
const findConflict = (cause: unknown, depth = 0): PortConflict | undefined => {
  if (depth > 10 || typeof cause !== "object" || cause === null) return undefined;
  if ("conflict" in cause && isPortConflict(cause.conflict)) return cause.conflict;
  if ("cause" in cause) return findConflict(cause.cause, depth + 1);
  return undefined;
};

/** A composition failure's member outcomes, each a plain Effect `Exit`, not just this cause's own. */
const conflictFromOutcomes = (
  outcomes: ReadonlyArray<{ readonly result: Exit.Exit<void, unknown> }> | undefined,
): PortConflict | undefined => {
  if (outcomes === undefined) return undefined;
  for (const { result } of outcomes) {
    if (!Exit.isFailure(result)) continue;
    const failure = Cause.findErrorOption(result.cause);
    if (Option.isNone(failure)) continue;
    const conflict = findConflict(failure.value);
    if (conflict !== undefined) return conflict;
  }
  return undefined;
};

/** Maps an owner failure to the RPC error, preserving per-member composition outcomes. */
export const stackError = (operation: string, cause: unknown): StackError => {
  if (Schema.is(StackError)(cause)) return cause;
  if (cause instanceof OrchestratorError && cause.outcomes !== undefined) {
    const conflict = findConflict(cause) ?? conflictFromOutcomes(cause.outcomes);
    return new StackError({
      operation,
      message: failureMessage(cause),
      outcomes: cause.outcomes.map(({ id, result }) => ({
        id,
        succeeded: Exit.isSuccess(result),
        ...(Exit.isFailure(result) ? { error: causeMessage(result.cause) } : {}),
      })),
      ...(conflict === undefined ? {} : { conflict }),
    });
  }
  const conflict = findConflict(cause);
  return new StackError({
    operation,
    message: failureMessage(cause),
    ...(conflict === undefined ? {} : { conflict }),
  });
};

const ServiceErrorSchema = Schema.TaggedStruct("ServiceError", {
  operation: Schema.String,
  message: Schema.String,
});

export const Observation = Schema.Struct({
  id: Schema.String,
  endpoints: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      protocol: Schema.Literals(["tcp", "http"]),
      host: Schema.String,
      port: Schema.Int,
    }),
  ),
  config: ServiceCreation,
  lifecycle: Schema.Literals(["stopped", "starting", "running", "stopping"]),
  health: Schema.UndefinedOr(Schema.Literals(["starting", "healthy", "unhealthy"])),
  error: Schema.UndefinedOr(ServiceErrorSchema),
  exit: Schema.UndefinedOr(Schema.Exit(Schema.Void, ServiceErrorSchema, Schema.Defect())),
  currentOperation: Schema.UndefinedOr(
    Schema.Literals(["start", "stop", "restart", "storage", "destroy", "sleep"]),
  ),
  wakeEnabled: Schema.Boolean,
});
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Definition = Schema.Struct({ id: Schema.String, creation: ServiceCreation });
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

const Instance = { id: Schema.String };
const SnapshotScope = Schema.Literals(snapshotScopes);
const Log = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  bytes: Schema.Uint8ArrayFromBase64,
});

export const CommandEvent = Schema.TaggedUnion({
  Attached: { attachmentId: Schema.String },
  Stdout: { bytes: Schema.Uint8ArrayFromBase64 },
  Stderr: { bytes: Schema.Uint8ArrayFromBase64 },
  Completed: { jobId: Schema.String, exitCode: Schema.Int },
});
export const RunCommandPayload = Schema.Struct({
  attachmentId: Schema.String,
  command: CommandInvocation,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type RunCommandPayload = Schema.Schema.Type<typeof RunCommandPayload>;

/** Instance and composition operations served by the owner. */
export const OwnerRpc = RpcGroup.make(
  Rpc.make("createService", {
    payload: ServiceCreationInput,
    success: Definition,
    error: StackError,
  }),
  Rpc.make("startService", { payload: Instance, error: StackError }),
  Rpc.make("readyService", { payload: Instance, error: StackError }),
  Rpc.make("stopService", { payload: Instance, error: StackError }),
  Rpc.make("restartService", {
    payload: { ...Instance, config: Schema.optionalKey(ServiceCreationInput) },
    error: StackError,
  }),
  Rpc.make("destroyService", { payload: Instance, error: StackError }),
  Rpc.make("prepareService", { payload: Instance, error: StackError }),
  Rpc.make("status", { payload: Instance, success: Observation, error: StackError }),
  Rpc.make("followStatus", {
    payload: Instance,
    success: Observation,
    error: StackError,
    stream: true,
  }),
  Rpc.make("logs", { payload: Instance, success: Log, error: StackError, stream: true }),
  Rpc.make("credentials", {
    payload: { ...Instance, from: Schema.Literals(["host", "runtime"]) },
    success: Schema.Record(Schema.String, Schema.String),
    error: StackError,
  }),
  Rpc.make("saveSnapshot", {
    payload: { ...Instance, key: Schema.String, scope: Schema.optionalKey(SnapshotScope) },
    error: StackError,
  }),
  Rpc.make("restoreSnapshot", {
    payload: { ...Instance, key: Schema.String, scope: Schema.optionalKey(SnapshotScope) },
    success: Schema.Boolean,
    error: StackError,
  }),
  Rpc.make("resetData", { payload: Instance, error: StackError }),
  Rpc.make("supabaseComposition", {
    payload: {
      services: Schema.Array(ServiceCreationInput),
      reuseIds: Schema.optionalKey(Schema.Array(Schema.String)),
      keys: Schema.optionalKey(StackKeysInput),
      eager: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Array(Definition),
    error: StackError,
  }),
  Rpc.make("configureComposition", { payload: CompositionConfig, error: StackError }),
  Rpc.make("startComposition", { success: Schema.Array(Observation), error: StackError }),
  Rpc.make("stopComposition", { success: Schema.Array(Observation), error: StackError }),
  Rpc.make("restartComposition", { success: Schema.Array(Observation), error: StackError }),
);

/** The private transport contract; lifecycle admission remains in the owner. */
export const StackRpc = OwnerRpc.add(
  Rpc.make("runCommand", {
    payload: RunCommandPayload,
    success: CommandEvent,
    error: StackError,
    stream: true,
  }),
  Rpc.make("commandInput", {
    payload: { attachmentId: Schema.String, bytes: Schema.NullOr(Schema.Uint8ArrayFromBase64) },
    error: StackError,
  }),
);
