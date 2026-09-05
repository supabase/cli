import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { EffectStackCredentialsSchema } from "../public/Credentials.ts";
import { StackConfigSchema } from "../public/Config.ts";
import { LogQuerySchema, StackLogBatchSchema } from "../public/Logs.ts";
import { StackStatusSchema } from "../public/Status.ts";
import { STACK_ERROR_TAGS } from "../public/Errors.ts";

/** Pinned release identifier used to detect incompatible live owners. */
export const STACK_RPC_RELEASE = "stack-rpc-v1@0.1.0" as const;

const StackRpcErrorTagSchema = Schema.Literals([...STACK_ERROR_TAGS] as const);

const StackRpcErrorSchema = Schema.Struct({
  tag: StackRpcErrorTagSchema,
  message: Schema.String,
});
export type StackRpcError = Schema.Schema.Type<typeof StackRpcErrorSchema>;

const StackRpc = {
  status: Rpc.make("status", { success: StackStatusSchema, error: StackRpcErrorSchema }),
  credentials: Rpc.make("credentials", {
    success: EffectStackCredentialsSchema,
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
  StackRpc.start,
  StackRpc.destroy,
  StackRpc.logs,
);
type StackRpcDefinitions = RpcGroup.Rpcs<typeof StackRpcGroup>;
export type StackRpcHandlers = {
  readonly [Current in StackRpcDefinitions as Current["_tag"]]: Rpc.ToHandlerFn<Current, never>;
};
export type StackRpcClient = RpcClient.FromGroup<typeof StackRpcGroup, RpcClientError>;

export const releaseMismatch = (actualRelease: string): string =>
  `Incompatible Stack RPC release; expected ${STACK_RPC_RELEASE}, received ${actualRelease}`;
