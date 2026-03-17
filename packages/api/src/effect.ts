import { Effect } from "effect";
import {
  makeSupabaseApiClient,
  type SupabaseApiClientOptions,
  type SupabaseApiConfig,
  SupabaseApiClient,
  supabaseApiClientLayer,
} from "./internal/client.ts";
import * as EffectModule from "effect/Effect";
import { makeEffectApiClient, makeV1ApiClientFacade } from "./internal/effect-client.ts";
import { effectOperations } from "./generated/effect-operations.ts";

export type {
  SupabaseApiClientShape,
  SupabaseApiError,
  SupabaseApiRetryOptions,
} from "./internal/client.ts";
export {
  makeSupabaseApiClient,
  SupabaseApiClient,
  SupabaseApiConfigError,
  supabaseApiClientLayer,
} from "./internal/client.ts";
export type { SupabaseApiClientOptions, SupabaseApiConfig } from "./internal/client.ts";
export { apiConfigLayer, DEFAULT_SUPABASE_API_URL } from "./config/api-config.layer.ts";
export { ApiConfig } from "./config/api-config.service.ts";

export {
  type OperationDefinition,
  type OperationId,
  type OperationInput,
  type OperationOutput,
  operationDefinitions,
} from "./generated/contracts.ts";
export * from "./generated/contracts.ts";
export * from "./generated/effect-operations.ts";

export const makeApiClient = (config: SupabaseApiConfig = {}, options?: SupabaseApiClientOptions) =>
  Effect.map(makeSupabaseApiClient(config, options), (client) =>
    makeV1ApiClientFacade(makeEffectApiClient(client, effectOperations)),
  );

export type ApiClient = EffectModule.Success<ReturnType<typeof makeApiClient>>;
