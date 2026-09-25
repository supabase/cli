import { Exit, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ServiceCreation, ServiceCreationInput } from "./services/Catalog.ts";
import { causeMessage, CompositionConfig, OrchestratorError } from "./Orchestrator.ts";
import { PgProveOptions, PostgresTool } from "./Tools.ts";
import { StackIdentityInput } from "./State.ts";
import { failureMessage } from "./internal/failure-message.ts";

const Outcome = Schema.Struct({
  id: Schema.String,
  succeeded: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

/** A typed failure returned by the stack owner. */
export class StackError extends Schema.TaggedError<StackError>()("StackError", {
  operation: Schema.String,
  message: Schema.String,
  outcomes: Schema.optionalKey(Schema.Array(Outcome)),
}) {}

/** Maps an owner failure to the RPC error, preserving per-member composition outcomes. */
export const stackError = (operation: string, cause: unknown): StackError => {
  if (Schema.is(StackError)(cause)) return cause;
  if (cause instanceof OrchestratorError && cause.outcomes !== undefined)
    return new StackError({
      operation,
      message: failureMessage(cause),
      outcomes: cause.outcomes.map(({ id, result }) => ({
        id,
        succeeded: Exit.isSuccess(result),
        ...(Exit.isFailure(result) ? { error: causeMessage(result.cause) } : {}),
      })),
    });
  return new StackError({ operation, message: failureMessage(cause) });
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
  cleanupError: Schema.UndefinedOr(ServiceErrorSchema),
  exit: Schema.UndefinedOr(Schema.Exit(Schema.Void, ServiceErrorSchema, Schema.Defect())),
  currentOperation: Schema.UndefinedOr(
    Schema.Literals(["start", "stop", "restart", "storage", "destroy", "sleep"]),
  ),
  launchId: Schema.UndefinedOr(Schema.Int),
  intentRevision: Schema.Int,
  wakeEnabled: Schema.Boolean,
  registered: Schema.Boolean,
});
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Definition = Schema.Struct({ id: Schema.String, creation: ServiceCreation });
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

const Instance = { id: Schema.String };
const Log = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  bytes: Schema.Uint8ArrayFromBase64,
});

export const ToolEvent = Schema.TaggedUnion({
  Attached: { attachmentId: Schema.String },
  Stdout: { bytes: Schema.Uint8ArrayFromBase64 },
  Stderr: { bytes: Schema.Uint8ArrayFromBase64 },
  Completed: { jobId: Schema.String, exitCode: Schema.Int },
});

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
    payload: { ...Instance, key: Schema.String },
    error: StackError,
  }),
  Rpc.make("restoreSnapshot", {
    payload: { ...Instance, key: Schema.String },
    success: Schema.Boolean,
    error: StackError,
  }),
  Rpc.make("resetData", { payload: Instance, error: StackError }),
  Rpc.make("supabaseComposition", {
    payload: {
      services: Schema.Array(ServiceCreationInput),
      reuseIds: Schema.optionalKey(Schema.Array(Schema.String)),
      identity: Schema.optionalKey(StackIdentityInput),
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
  Rpc.make("shutdown", { payload: { destroy: Schema.Boolean }, error: StackError }),
  Rpc.make("runTool", {
    payload: {
      attachmentId: Schema.String,
      tool: PostgresTool,
      args: Schema.Array(Schema.String),
      env: Schema.Record(Schema.String, Schema.String),
      pgProve: Schema.optionalKey(PgProveOptions),
      stdin: Schema.Boolean,
    },
    success: ToolEvent,
    error: StackError,
    stream: true,
  }),
  Rpc.make("toolInput", {
    payload: { attachmentId: Schema.String, bytes: Schema.NullOr(Schema.Uint8ArrayFromBase64) },
    error: StackError,
  }),
);
