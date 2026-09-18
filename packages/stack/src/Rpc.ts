import { Data, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ServiceCreation } from "./services/Catalog.ts";
import { CompositionConfig } from "./Orchestrator.ts";
import { SnapshotDescriptor } from "./services/DatabaseSnapshot.ts";
import { PgProveOptions, PostgresTool } from "./Tools.ts";

const Outcome = Schema.Struct({
  id: Schema.String,
  succeeded: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

export const StackErrorSchema = Schema.TaggedStruct("StackError", {
  operation: Schema.String,
  message: Schema.String,
  outcomes: Schema.optionalKey(Schema.Array(Outcome)),
});
type StackErrorPayload = Omit<Schema.Schema.Type<typeof StackErrorSchema>, "_tag">;

/** A typed failure returned by the stack owner. */
export class StackError extends Data.TaggedError("StackError")<StackErrorPayload> {}

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
const Snapshot = Schema.Struct({ descriptor: SnapshotDescriptor, destination: Schema.String });
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

/** The private transport contract; lifecycle admission remains in the owner. */
export const StackRpc = RpcGroup.make(
  Rpc.make("createService", {
    payload: ServiceCreation,
    success: Definition,
    error: StackErrorSchema,
  }),
  Rpc.make("getService", { payload: Instance, success: Definition, error: StackErrorSchema }),
  Rpc.make("listServices", { success: Schema.Array(Definition), error: StackErrorSchema }),
  Rpc.make("startService", { payload: Instance, error: StackErrorSchema }),
  Rpc.make("readyService", { payload: Instance, error: StackErrorSchema }),
  Rpc.make("stopService", { payload: Instance, error: StackErrorSchema }),
  Rpc.make("restartService", {
    payload: { ...Instance, config: Schema.optionalKey(ServiceCreation) },
    error: StackErrorSchema,
  }),
  Rpc.make("destroyService", { payload: Instance, error: StackErrorSchema }),
  Rpc.make("prepareService", { payload: Instance, error: StackErrorSchema }),
  Rpc.make("status", { payload: Instance, success: Observation, error: StackErrorSchema }),
  Rpc.make("followStatus", {
    payload: Instance,
    success: Observation,
    error: StackErrorSchema,
    stream: true,
  }),
  Rpc.make("logs", { payload: Instance, success: Log, error: StackErrorSchema, stream: true }),
  Rpc.make("credentials", {
    payload: { ...Instance, from: Schema.Literals(["host", "runtime"]) },
    success: Schema.Record(Schema.String, Schema.String),
    error: StackErrorSchema,
  }),
  Rpc.make("exportSnapshot", {
    payload: { ...Instance, destination: Schema.String },
    success: Snapshot,
    error: StackErrorSchema,
  }),
  Rpc.make("restoreSnapshot", {
    payload: { ...Instance, source: Schema.String },
    success: Snapshot,
    error: StackErrorSchema,
  }),
  Rpc.make("supabaseComposition", {
    payload: { services: Schema.Array(ServiceCreation) },
    success: Schema.Array(Definition),
    error: StackErrorSchema,
  }),
  Rpc.make("configureComposition", { payload: CompositionConfig, error: StackErrorSchema }),
  Rpc.make("getComposition", { success: CompositionConfig, error: StackErrorSchema }),
  Rpc.make("startComposition", { success: Schema.Array(Observation), error: StackErrorSchema }),
  Rpc.make("stopComposition", { success: Schema.Array(Observation), error: StackErrorSchema }),
  Rpc.make("restartComposition", { success: Schema.Array(Observation), error: StackErrorSchema }),
  Rpc.make("shutdown", { payload: { destroy: Schema.Boolean }, error: StackErrorSchema }),
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
    error: StackErrorSchema,
    stream: true,
  }),
  Rpc.make("toolInput", {
    payload: { attachmentId: Schema.String, bytes: Schema.NullOr(Schema.Uint8ArrayFromBase64) },
    error: StackErrorSchema,
  }),
);
