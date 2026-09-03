import { Data, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { EffectStackCredentialsSchema } from "../public/Credentials.ts";
import { StackConfigSchema } from "../public/Config.ts";
import { CapabilityNameSchema } from "../public/Capability.ts";
import { LogQuerySchema, StackLogBatchSchema } from "../public/Logs.ts";
import { StackStatusSchema } from "../public/Status.ts";
import { STACK_ERROR_TAGS } from "../public/Errors.ts";

/** Pinned release identifier used to detect incompatible live owners. */
export const STACK_RPC_RELEASE = "stack-rpc-v1@0.1.0" as const;

export class StackRpcProtocolError extends Data.TaggedError("StackRpcProtocolError")<{
  readonly message: string;
  readonly expectedRelease?: string;
  readonly actualRelease?: string;
}> {}

const StackRpcErrorTagSchema = Schema.Literals([
  ...STACK_ERROR_TAGS,
  "StackRpcProtocolError",
] as const);

const StackRpcErrorSchema = Schema.Struct({
  tag: StackRpcErrorTagSchema,
  message: Schema.String,
});
export type StackRpcError = Schema.Schema.Type<typeof StackRpcErrorSchema>;

const PrepareStackResultSchema = Schema.Struct({
  capabilities: Schema.Array(
    Schema.Struct({
      capability: CapabilityNameSchema,
      version: Schema.String,
      outcome: Schema.Literals(["cached", "downloaded", "pulled"] as const),
    }),
  ),
});

const StackRpc = {
  status: Rpc.make("status", { success: StackStatusSchema, error: StackRpcErrorSchema }),
  credentials: Rpc.make("credentials", {
    success: EffectStackCredentialsSchema,
    error: StackRpcErrorSchema,
  }),
  prepare: Rpc.make("prepare", {
    payload: Schema.Struct({
      config: Schema.optionalKey(StackConfigSchema),
      capabilities: Schema.optionalKey(Schema.Array(CapabilityNameSchema)),
    }),
    success: PrepareStackResultSchema,
    error: StackRpcErrorSchema,
  }),
  start: Rpc.make("start", {
    payload: Schema.Struct({ config: Schema.optionalKey(StackConfigSchema) }),
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
  }),
  destroy: Rpc.make("destroy", { success: Schema.Void, error: StackRpcErrorSchema }),
  logs: Rpc.make("logs", {
    payload: LogQuerySchema,
    success: StackLogBatchSchema,
    error: StackRpcErrorSchema,
  }),
} as const;

export const StackRpcGroup = RpcGroup.make(
  StackRpc.status,
  StackRpc.credentials,
  StackRpc.prepare,
  StackRpc.start,
  StackRpc.destroy,
  StackRpc.logs,
);
type StackRpcDefinitions = RpcGroup.Rpcs<typeof StackRpcGroup>;
export type StackRpcHandlers = {
  readonly [Current in StackRpcDefinitions as Current["_tag"]]: Rpc.ToHandlerFn<Current, never>;
};
export type StackRpcClient = RpcClient.FromGroup<typeof StackRpcGroup, RpcClientError>;

export const releaseMismatch = (actualRelease: string): StackRpcProtocolError =>
  new StackRpcProtocolError({
    message: `Incompatible Stack RPC release; expected ${STACK_RPC_RELEASE}, received ${actualRelease}`,
    expectedRelease: STACK_RPC_RELEASE,
    actualRelease,
  });
