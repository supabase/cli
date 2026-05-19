import { Effect } from "effect";
import {
  makeSupabaseApiClient,
  type SupabaseApiClientOptions,
  type SupabaseApiConfig,
} from "./internal/client.ts";
import { makeEffectApiClient, type EffectClient } from "./internal/effect-client.ts";
import {
  type GeneratedEffectOperations,
  versionedEffectOperations,
} from "./generated/effect-client.ts";

export type { SupabaseApiError, SupabaseApiRetryOptions } from "./internal/client.ts";
export { SupabaseApiConfigError } from "./internal/client.ts";
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
export { executeApiClientOperation } from "./generated/effect-client.ts";

export const makeApiClient = (config: SupabaseApiConfig = {}, options?: SupabaseApiClientOptions) =>
  Effect.map(makeSupabaseApiClient(config, options), (client) =>
    makeEffectApiClient(client, versionedEffectOperations),
  );

export type ApiClient = EffectClient<GeneratedEffectOperations>;
