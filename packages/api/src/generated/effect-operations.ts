import { Effect } from "effect";

import type { SupabaseApiError } from "../internal/client.ts";
import { SupabaseApiClient } from "../internal/client.ts";
import { operationDefinitions } from "./contracts.ts";

export const v1ActivateCustomHostname = (
  input: typeof operationDefinitions.v1ActivateCustomHostname.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ActivateCustomHostname.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ActivateCustomHostname">(
      operationDefinitions.v1ActivateCustomHostname,
      input,
    );
  });

export const v1ActivateVanitySubdomainConfig = (
  input: typeof operationDefinitions.v1ActivateVanitySubdomainConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ActivateVanitySubdomainConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ActivateVanitySubdomainConfig">(
      operationDefinitions.v1ActivateVanitySubdomainConfig,
      input,
    );
  });

export const v1ApplyAMigration = (
  input: typeof operationDefinitions.v1ApplyAMigration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ApplyAMigration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ApplyAMigration">(
      operationDefinitions.v1ApplyAMigration,
      input,
    );
  });

export const v1ApplyProjectAddon = (
  input: typeof operationDefinitions.v1ApplyProjectAddon.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ApplyProjectAddon.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ApplyProjectAddon">(
      operationDefinitions.v1ApplyProjectAddon,
      input,
    );
  });

export const v1AuthorizeJitAccess = (
  input: typeof operationDefinitions.v1AuthorizeJitAccess.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1AuthorizeJitAccess.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1AuthorizeJitAccess">(
      operationDefinitions.v1AuthorizeJitAccess,
      input,
    );
  });

export const v1AuthorizeUser = (
  input: typeof operationDefinitions.v1AuthorizeUser.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1AuthorizeUser.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1AuthorizeUser">(operationDefinitions.v1AuthorizeUser, input);
  });

export const v1BulkCreateSecrets = (
  input: typeof operationDefinitions.v1BulkCreateSecrets.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1BulkCreateSecrets.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1BulkCreateSecrets">(
      operationDefinitions.v1BulkCreateSecrets,
      input,
    );
  });

export const v1BulkDeleteSecrets = (
  input: typeof operationDefinitions.v1BulkDeleteSecrets.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1BulkDeleteSecrets.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1BulkDeleteSecrets">(
      operationDefinitions.v1BulkDeleteSecrets,
      input,
    );
  });

export const v1BulkUpdateFunctions = (
  input: typeof operationDefinitions.v1BulkUpdateFunctions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1BulkUpdateFunctions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1BulkUpdateFunctions">(
      operationDefinitions.v1BulkUpdateFunctions,
      input,
    );
  });

export const v1CancelAProjectRestoration = (
  input: typeof operationDefinitions.v1CancelAProjectRestoration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CancelAProjectRestoration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CancelAProjectRestoration">(
      operationDefinitions.v1CancelAProjectRestoration,
      input,
    );
  });

export const v1CheckVanitySubdomainAvailability = (
  input: typeof operationDefinitions.v1CheckVanitySubdomainAvailability.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CheckVanitySubdomainAvailability.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CheckVanitySubdomainAvailability">(
      operationDefinitions.v1CheckVanitySubdomainAvailability,
      input,
    );
  });

export const v1ClaimProjectForOrganization = (
  input: typeof operationDefinitions.v1ClaimProjectForOrganization.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ClaimProjectForOrganization.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ClaimProjectForOrganization">(
      operationDefinitions.v1ClaimProjectForOrganization,
      input,
    );
  });

export const v1CountActionRuns = (
  input: typeof operationDefinitions.v1CountActionRuns.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CountActionRuns.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CountActionRuns">(
      operationDefinitions.v1CountActionRuns,
      input,
    );
  });

export const v1CreateABranch = (
  input: typeof operationDefinitions.v1CreateABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateABranch">(operationDefinitions.v1CreateABranch, input);
  });

export const v1CreateAFunction = (
  input: typeof operationDefinitions.v1CreateAFunction.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateAFunction.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateAFunction">(
      operationDefinitions.v1CreateAFunction,
      input,
    );
  });

export const v1CreateAProject = (
  input: typeof operationDefinitions.v1CreateAProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateAProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateAProject">(operationDefinitions.v1CreateAProject, input);
  });

export const v1CreateASsoProvider = (
  input: typeof operationDefinitions.v1CreateASsoProvider.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateASsoProvider.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateASsoProvider">(
      operationDefinitions.v1CreateASsoProvider,
      input,
    );
  });

export const v1CreateAnOrganization = (
  input: typeof operationDefinitions.v1CreateAnOrganization.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateAnOrganization.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateAnOrganization">(
      operationDefinitions.v1CreateAnOrganization,
      input,
    );
  });

export const v1CreateLegacySigningKey = (
  input: typeof operationDefinitions.v1CreateLegacySigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateLegacySigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateLegacySigningKey">(
      operationDefinitions.v1CreateLegacySigningKey,
      input,
    );
  });

export const v1CreateLoginRole = (
  input: typeof operationDefinitions.v1CreateLoginRole.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateLoginRole.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateLoginRole">(
      operationDefinitions.v1CreateLoginRole,
      input,
    );
  });

export const v1CreateProjectApiKey = (
  input: typeof operationDefinitions.v1CreateProjectApiKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateProjectApiKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateProjectApiKey">(
      operationDefinitions.v1CreateProjectApiKey,
      input,
    );
  });

export const v1CreateProjectClaimToken = (
  input: typeof operationDefinitions.v1CreateProjectClaimToken.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateProjectClaimToken.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateProjectClaimToken">(
      operationDefinitions.v1CreateProjectClaimToken,
      input,
    );
  });

export const v1CreateProjectSigningKey = (
  input: typeof operationDefinitions.v1CreateProjectSigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateProjectSigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateProjectSigningKey">(
      operationDefinitions.v1CreateProjectSigningKey,
      input,
    );
  });

export const v1CreateProjectTpaIntegration = (
  input: typeof operationDefinitions.v1CreateProjectTpaIntegration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateProjectTpaIntegration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateProjectTpaIntegration">(
      operationDefinitions.v1CreateProjectTpaIntegration,
      input,
    );
  });

export const v1CreateRestorePoint = (
  input: typeof operationDefinitions.v1CreateRestorePoint.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1CreateRestorePoint.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1CreateRestorePoint">(
      operationDefinitions.v1CreateRestorePoint,
      input,
    );
  });

export const v1DeactivateVanitySubdomainConfig = (
  input: typeof operationDefinitions.v1DeactivateVanitySubdomainConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeactivateVanitySubdomainConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeactivateVanitySubdomainConfig">(
      operationDefinitions.v1DeactivateVanitySubdomainConfig,
      input,
    );
  });

export const v1DeleteHostnameConfig = (
  input: typeof operationDefinitions.v1DeleteHostnameConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteHostnameConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteHostnameConfig">(
      operationDefinitions.v1DeleteHostnameConfig,
      input,
    );
  });

export const v1DeleteABranch = (
  input: typeof operationDefinitions.v1DeleteABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteABranch">(operationDefinitions.v1DeleteABranch, input);
  });

export const v1DeleteAFunction = (
  input: typeof operationDefinitions.v1DeleteAFunction.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteAFunction.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteAFunction">(
      operationDefinitions.v1DeleteAFunction,
      input,
    );
  });

export const v1DeleteAProject = (
  input: typeof operationDefinitions.v1DeleteAProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteAProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteAProject">(operationDefinitions.v1DeleteAProject, input);
  });

export const v1DeleteASsoProvider = (
  input: typeof operationDefinitions.v1DeleteASsoProvider.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteASsoProvider.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteASsoProvider">(
      operationDefinitions.v1DeleteASsoProvider,
      input,
    );
  });

export const v1DeleteJitAccess = (
  input: typeof operationDefinitions.v1DeleteJitAccess.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteJitAccess.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteJitAccess">(
      operationDefinitions.v1DeleteJitAccess,
      input,
    );
  });

export const v1DeleteLoginRoles = (
  input: typeof operationDefinitions.v1DeleteLoginRoles.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteLoginRoles.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteLoginRoles">(
      operationDefinitions.v1DeleteLoginRoles,
      input,
    );
  });

export const v1DeleteNetworkBans = (
  input: typeof operationDefinitions.v1DeleteNetworkBans.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteNetworkBans.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteNetworkBans">(
      operationDefinitions.v1DeleteNetworkBans,
      input,
    );
  });

export const v1DeleteProjectApiKey = (
  input: typeof operationDefinitions.v1DeleteProjectApiKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteProjectApiKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteProjectApiKey">(
      operationDefinitions.v1DeleteProjectApiKey,
      input,
    );
  });

export const v1DeleteProjectClaimToken = (
  input: typeof operationDefinitions.v1DeleteProjectClaimToken.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteProjectClaimToken.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteProjectClaimToken">(
      operationDefinitions.v1DeleteProjectClaimToken,
      input,
    );
  });

export const v1DeleteProjectTpaIntegration = (
  input: typeof operationDefinitions.v1DeleteProjectTpaIntegration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeleteProjectTpaIntegration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeleteProjectTpaIntegration">(
      operationDefinitions.v1DeleteProjectTpaIntegration,
      input,
    );
  });

export const v1DeployAFunction = (
  input: typeof operationDefinitions.v1DeployAFunction.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DeployAFunction.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DeployAFunction">(
      operationDefinitions.v1DeployAFunction,
      input,
    );
  });

export const v1DiffABranch = (
  input: typeof operationDefinitions.v1DiffABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DiffABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DiffABranch">(operationDefinitions.v1DiffABranch, input);
  });

export const v1DisablePreviewBranching = (
  input: typeof operationDefinitions.v1DisablePreviewBranching.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DisablePreviewBranching.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DisablePreviewBranching">(
      operationDefinitions.v1DisablePreviewBranching,
      input,
    );
  });

export const v1DisableReadonlyModeTemporarily = (
  input: typeof operationDefinitions.v1DisableReadonlyModeTemporarily.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1DisableReadonlyModeTemporarily.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1DisableReadonlyModeTemporarily">(
      operationDefinitions.v1DisableReadonlyModeTemporarily,
      input,
    );
  });

export const v1EnableDatabaseWebhook = (
  input: typeof operationDefinitions.v1EnableDatabaseWebhook.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1EnableDatabaseWebhook.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1EnableDatabaseWebhook">(
      operationDefinitions.v1EnableDatabaseWebhook,
      input,
    );
  });

export const v1ExchangeOauthToken = (
  input: typeof operationDefinitions.v1ExchangeOauthToken.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ExchangeOauthToken.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ExchangeOauthToken">(
      operationDefinitions.v1ExchangeOauthToken,
      input,
    );
  });

export const v1GenerateTypescriptTypes = (
  input: typeof operationDefinitions.v1GenerateTypescriptTypes.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GenerateTypescriptTypes.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GenerateTypescriptTypes">(
      operationDefinitions.v1GenerateTypescriptTypes,
      input,
    );
  });

export const v1GetABranch = (
  input: typeof operationDefinitions.v1GetABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetABranch">(operationDefinitions.v1GetABranch, input);
  });

export const v1GetABranchConfig = (
  input: typeof operationDefinitions.v1GetABranchConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetABranchConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetABranchConfig">(
      operationDefinitions.v1GetABranchConfig,
      input,
    );
  });

export const v1GetAFunction = (
  input: typeof operationDefinitions.v1GetAFunction.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAFunction.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAFunction">(operationDefinitions.v1GetAFunction, input);
  });

export const v1GetAFunctionBody = (
  input: typeof operationDefinitions.v1GetAFunctionBody.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAFunctionBody.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAFunctionBody">(
      operationDefinitions.v1GetAFunctionBody,
      input,
    );
  });

export const v1GetAMigration = (
  input: typeof operationDefinitions.v1GetAMigration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAMigration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAMigration">(operationDefinitions.v1GetAMigration, input);
  });

export const v1GetASnippet = (
  input: typeof operationDefinitions.v1GetASnippet.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetASnippet.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetASnippet">(operationDefinitions.v1GetASnippet, input);
  });

export const v1GetASsoProvider = (
  input: typeof operationDefinitions.v1GetASsoProvider.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetASsoProvider.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetASsoProvider">(
      operationDefinitions.v1GetASsoProvider,
      input,
    );
  });

export const v1GetActionRun = (
  input: typeof operationDefinitions.v1GetActionRun.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetActionRun.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetActionRun">(operationDefinitions.v1GetActionRun, input);
  });

export const v1GetActionRunLogs = (
  input: typeof operationDefinitions.v1GetActionRunLogs.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetActionRunLogs.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetActionRunLogs">(
      operationDefinitions.v1GetActionRunLogs,
      input,
    );
  });

export const v1GetAllProjectsForOrganization = (
  input: typeof operationDefinitions.v1GetAllProjectsForOrganization.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAllProjectsForOrganization.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAllProjectsForOrganization">(
      operationDefinitions.v1GetAllProjectsForOrganization,
      input,
    );
  });

export const v1GetAnOrganization = (
  input: typeof operationDefinitions.v1GetAnOrganization.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAnOrganization.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAnOrganization">(
      operationDefinitions.v1GetAnOrganization,
      input,
    );
  });

export const v1GetAuthServiceConfig = (
  input: typeof operationDefinitions.v1GetAuthServiceConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAuthServiceConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAuthServiceConfig">(
      operationDefinitions.v1GetAuthServiceConfig,
      input,
    );
  });

export const v1GetAvailableRegions = (
  input: typeof operationDefinitions.v1GetAvailableRegions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetAvailableRegions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetAvailableRegions">(
      operationDefinitions.v1GetAvailableRegions,
      input,
    );
  });

export const v1GetDatabaseDisk = (
  input: typeof operationDefinitions.v1GetDatabaseDisk.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetDatabaseDisk.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetDatabaseDisk">(
      operationDefinitions.v1GetDatabaseDisk,
      input,
    );
  });

export const v1GetDatabaseMetadata = (
  input: typeof operationDefinitions.v1GetDatabaseMetadata.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetDatabaseMetadata.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetDatabaseMetadata">(
      operationDefinitions.v1GetDatabaseMetadata,
      input,
    );
  });

export const v1GetDiskUtilization = (
  input: typeof operationDefinitions.v1GetDiskUtilization.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetDiskUtilization.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetDiskUtilization">(
      operationDefinitions.v1GetDiskUtilization,
      input,
    );
  });

export const v1GetHostnameConfig = (
  input: typeof operationDefinitions.v1GetHostnameConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetHostnameConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetHostnameConfig">(
      operationDefinitions.v1GetHostnameConfig,
      input,
    );
  });

export const v1GetJitAccess = (
  input: typeof operationDefinitions.v1GetJitAccess.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetJitAccess.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetJitAccess">(operationDefinitions.v1GetJitAccess, input);
  });

export const v1GetJitAccessConfig = (
  input: typeof operationDefinitions.v1GetJitAccessConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetJitAccessConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetJitAccessConfig">(
      operationDefinitions.v1GetJitAccessConfig,
      input,
    );
  });

export const v1GetLegacySigningKey = (
  input: typeof operationDefinitions.v1GetLegacySigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetLegacySigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetLegacySigningKey">(
      operationDefinitions.v1GetLegacySigningKey,
      input,
    );
  });

export const v1GetNetworkRestrictions = (
  input: typeof operationDefinitions.v1GetNetworkRestrictions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetNetworkRestrictions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetNetworkRestrictions">(
      operationDefinitions.v1GetNetworkRestrictions,
      input,
    );
  });

export const v1GetOrganizationProjectClaim = (
  input: typeof operationDefinitions.v1GetOrganizationProjectClaim.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetOrganizationProjectClaim.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetOrganizationProjectClaim">(
      operationDefinitions.v1GetOrganizationProjectClaim,
      input,
    );
  });

export const v1GetPerformanceAdvisors = (
  input: typeof operationDefinitions.v1GetPerformanceAdvisors.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPerformanceAdvisors.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPerformanceAdvisors">(
      operationDefinitions.v1GetPerformanceAdvisors,
      input,
    );
  });

export const v1GetPgsodiumConfig = (
  input: typeof operationDefinitions.v1GetPgsodiumConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPgsodiumConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPgsodiumConfig">(
      operationDefinitions.v1GetPgsodiumConfig,
      input,
    );
  });

export const v1GetPoolerConfig = (
  input: typeof operationDefinitions.v1GetPoolerConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPoolerConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPoolerConfig">(
      operationDefinitions.v1GetPoolerConfig,
      input,
    );
  });

export const v1GetPostgresConfig = (
  input: typeof operationDefinitions.v1GetPostgresConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPostgresConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPostgresConfig">(
      operationDefinitions.v1GetPostgresConfig,
      input,
    );
  });

export const v1GetPostgresUpgradeEligibility = (
  input: typeof operationDefinitions.v1GetPostgresUpgradeEligibility.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPostgresUpgradeEligibility.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPostgresUpgradeEligibility">(
      operationDefinitions.v1GetPostgresUpgradeEligibility,
      input,
    );
  });

export const v1GetPostgresUpgradeStatus = (
  input: typeof operationDefinitions.v1GetPostgresUpgradeStatus.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPostgresUpgradeStatus.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPostgresUpgradeStatus">(
      operationDefinitions.v1GetPostgresUpgradeStatus,
      input,
    );
  });

export const v1GetPostgrestServiceConfig = (
  input: typeof operationDefinitions.v1GetPostgrestServiceConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetPostgrestServiceConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetPostgrestServiceConfig">(
      operationDefinitions.v1GetPostgrestServiceConfig,
      input,
    );
  });

export const v1GetProject = (
  input: typeof operationDefinitions.v1GetProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProject">(operationDefinitions.v1GetProject, input);
  });

export const v1GetProjectApiKey = (
  input: typeof operationDefinitions.v1GetProjectApiKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectApiKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectApiKey">(
      operationDefinitions.v1GetProjectApiKey,
      input,
    );
  });

export const v1GetProjectApiKeys = (
  input: typeof operationDefinitions.v1GetProjectApiKeys.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectApiKeys.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectApiKeys">(
      operationDefinitions.v1GetProjectApiKeys,
      input,
    );
  });

export const v1GetProjectClaimToken = (
  input: typeof operationDefinitions.v1GetProjectClaimToken.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectClaimToken.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectClaimToken">(
      operationDefinitions.v1GetProjectClaimToken,
      input,
    );
  });

export const v1GetProjectDiskAutoscaleConfig = (
  input: typeof operationDefinitions.v1GetProjectDiskAutoscaleConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectDiskAutoscaleConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectDiskAutoscaleConfig">(
      operationDefinitions.v1GetProjectDiskAutoscaleConfig,
      input,
    );
  });

export const v1GetProjectFunctionCombinedStats = (
  input: typeof operationDefinitions.v1GetProjectFunctionCombinedStats.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectFunctionCombinedStats.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectFunctionCombinedStats">(
      operationDefinitions.v1GetProjectFunctionCombinedStats,
      input,
    );
  });

export const v1GetProjectLegacyApiKeys = (
  input: typeof operationDefinitions.v1GetProjectLegacyApiKeys.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectLegacyApiKeys.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectLegacyApiKeys">(
      operationDefinitions.v1GetProjectLegacyApiKeys,
      input,
    );
  });

export const v1GetProjectLogs = (
  input: typeof operationDefinitions.v1GetProjectLogs.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectLogs.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectLogs">(operationDefinitions.v1GetProjectLogs, input);
  });

export const v1GetProjectPgbouncerConfig = (
  input: typeof operationDefinitions.v1GetProjectPgbouncerConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectPgbouncerConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectPgbouncerConfig">(
      operationDefinitions.v1GetProjectPgbouncerConfig,
      input,
    );
  });

export const v1GetProjectSigningKey = (
  input: typeof operationDefinitions.v1GetProjectSigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectSigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectSigningKey">(
      operationDefinitions.v1GetProjectSigningKey,
      input,
    );
  });

export const v1GetProjectSigningKeys = (
  input: typeof operationDefinitions.v1GetProjectSigningKeys.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectSigningKeys.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectSigningKeys">(
      operationDefinitions.v1GetProjectSigningKeys,
      input,
    );
  });

export const v1GetProjectTpaIntegration = (
  input: typeof operationDefinitions.v1GetProjectTpaIntegration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectTpaIntegration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectTpaIntegration">(
      operationDefinitions.v1GetProjectTpaIntegration,
      input,
    );
  });

export const v1GetProjectUsageApiCount = (
  input: typeof operationDefinitions.v1GetProjectUsageApiCount.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectUsageApiCount.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectUsageApiCount">(
      operationDefinitions.v1GetProjectUsageApiCount,
      input,
    );
  });

export const v1GetProjectUsageRequestCount = (
  input: typeof operationDefinitions.v1GetProjectUsageRequestCount.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetProjectUsageRequestCount.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetProjectUsageRequestCount">(
      operationDefinitions.v1GetProjectUsageRequestCount,
      input,
    );
  });

export const v1GetReadonlyModeStatus = (
  input: typeof operationDefinitions.v1GetReadonlyModeStatus.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetReadonlyModeStatus.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetReadonlyModeStatus">(
      operationDefinitions.v1GetReadonlyModeStatus,
      input,
    );
  });

export const v1GetRealtimeConfig = (
  input: typeof operationDefinitions.v1GetRealtimeConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetRealtimeConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetRealtimeConfig">(
      operationDefinitions.v1GetRealtimeConfig,
      input,
    );
  });

export const v1GetRestorePoint = (
  input: typeof operationDefinitions.v1GetRestorePoint.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetRestorePoint.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetRestorePoint">(
      operationDefinitions.v1GetRestorePoint,
      input,
    );
  });

export const v1GetSecurityAdvisors = (
  input: typeof operationDefinitions.v1GetSecurityAdvisors.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetSecurityAdvisors.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetSecurityAdvisors">(
      operationDefinitions.v1GetSecurityAdvisors,
      input,
    );
  });

export const v1GetServicesHealth = (
  input: typeof operationDefinitions.v1GetServicesHealth.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetServicesHealth.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetServicesHealth">(
      operationDefinitions.v1GetServicesHealth,
      input,
    );
  });

export const v1GetSslEnforcementConfig = (
  input: typeof operationDefinitions.v1GetSslEnforcementConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetSslEnforcementConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetSslEnforcementConfig">(
      operationDefinitions.v1GetSslEnforcementConfig,
      input,
    );
  });

export const v1GetStorageConfig = (
  input: typeof operationDefinitions.v1GetStorageConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetStorageConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetStorageConfig">(
      operationDefinitions.v1GetStorageConfig,
      input,
    );
  });

export const v1GetVanitySubdomainConfig = (
  input: typeof operationDefinitions.v1GetVanitySubdomainConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1GetVanitySubdomainConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1GetVanitySubdomainConfig">(
      operationDefinitions.v1GetVanitySubdomainConfig,
      input,
    );
  });

export const v1ListActionRuns = (
  input: typeof operationDefinitions.v1ListActionRuns.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListActionRuns.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListActionRuns">(operationDefinitions.v1ListActionRuns, input);
  });

export const v1ListAllBackups = (
  input: typeof operationDefinitions.v1ListAllBackups.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllBackups.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllBackups">(operationDefinitions.v1ListAllBackups, input);
  });

export const v1ListAllBranches = (
  input: typeof operationDefinitions.v1ListAllBranches.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllBranches.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllBranches">(
      operationDefinitions.v1ListAllBranches,
      input,
    );
  });

export const v1ListAllBuckets = (
  input: typeof operationDefinitions.v1ListAllBuckets.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllBuckets.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllBuckets">(operationDefinitions.v1ListAllBuckets, input);
  });

export const v1ListAllFunctions = (
  input: typeof operationDefinitions.v1ListAllFunctions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllFunctions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllFunctions">(
      operationDefinitions.v1ListAllFunctions,
      input,
    );
  });

export const v1ListAllNetworkBans = (
  input: typeof operationDefinitions.v1ListAllNetworkBans.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllNetworkBans.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllNetworkBans">(
      operationDefinitions.v1ListAllNetworkBans,
      input,
    );
  });

export const v1ListAllNetworkBansEnriched = (
  input: typeof operationDefinitions.v1ListAllNetworkBansEnriched.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllNetworkBansEnriched.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllNetworkBansEnriched">(
      operationDefinitions.v1ListAllNetworkBansEnriched,
      input,
    );
  });

export const v1ListAllOrganizations = (): Effect.Effect<
  typeof operationDefinitions.v1ListAllOrganizations.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllOrganizations">(
      operationDefinitions.v1ListAllOrganizations,
      {},
    );
  });

export const v1ListAllProjects = (): Effect.Effect<
  typeof operationDefinitions.v1ListAllProjects.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllProjects">(operationDefinitions.v1ListAllProjects, {});
  });

export const v1ListAllSecrets = (
  input: typeof operationDefinitions.v1ListAllSecrets.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllSecrets.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllSecrets">(operationDefinitions.v1ListAllSecrets, input);
  });

export const v1ListAllSnippets = (
  input: typeof operationDefinitions.v1ListAllSnippets.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllSnippets.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllSnippets">(
      operationDefinitions.v1ListAllSnippets,
      input,
    );
  });

export const v1ListAllSsoProvider = (
  input: typeof operationDefinitions.v1ListAllSsoProvider.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAllSsoProvider.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAllSsoProvider">(
      operationDefinitions.v1ListAllSsoProvider,
      input,
    );
  });

export const v1ListAvailableRestoreVersions = (
  input: typeof operationDefinitions.v1ListAvailableRestoreVersions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListAvailableRestoreVersions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListAvailableRestoreVersions">(
      operationDefinitions.v1ListAvailableRestoreVersions,
      input,
    );
  });

export const v1ListJitAccess = (
  input: typeof operationDefinitions.v1ListJitAccess.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListJitAccess.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListJitAccess">(operationDefinitions.v1ListJitAccess, input);
  });

export const v1ListMigrationHistory = (
  input: typeof operationDefinitions.v1ListMigrationHistory.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListMigrationHistory.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListMigrationHistory">(
      operationDefinitions.v1ListMigrationHistory,
      input,
    );
  });

export const v1ListOrganizationMembers = (
  input: typeof operationDefinitions.v1ListOrganizationMembers.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListOrganizationMembers.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListOrganizationMembers">(
      operationDefinitions.v1ListOrganizationMembers,
      input,
    );
  });

export const v1ListProjectAddons = (
  input: typeof operationDefinitions.v1ListProjectAddons.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListProjectAddons.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListProjectAddons">(
      operationDefinitions.v1ListProjectAddons,
      input,
    );
  });

export const v1ListProjectTpaIntegrations = (
  input: typeof operationDefinitions.v1ListProjectTpaIntegrations.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ListProjectTpaIntegrations.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ListProjectTpaIntegrations">(
      operationDefinitions.v1ListProjectTpaIntegrations,
      input,
    );
  });

export const v1MergeABranch = (
  input: typeof operationDefinitions.v1MergeABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1MergeABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1MergeABranch">(operationDefinitions.v1MergeABranch, input);
  });

export const v1ModifyDatabaseDisk = (
  input: typeof operationDefinitions.v1ModifyDatabaseDisk.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ModifyDatabaseDisk.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ModifyDatabaseDisk">(
      operationDefinitions.v1ModifyDatabaseDisk,
      input,
    );
  });

export const v1OauthAuthorizeProjectClaim = (
  input: typeof operationDefinitions.v1OauthAuthorizeProjectClaim.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1OauthAuthorizeProjectClaim.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1OauthAuthorizeProjectClaim">(
      operationDefinitions.v1OauthAuthorizeProjectClaim,
      input,
    );
  });

export const v1PatchAMigration = (
  input: typeof operationDefinitions.v1PatchAMigration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1PatchAMigration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1PatchAMigration">(
      operationDefinitions.v1PatchAMigration,
      input,
    );
  });

export const v1PatchNetworkRestrictions = (
  input: typeof operationDefinitions.v1PatchNetworkRestrictions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1PatchNetworkRestrictions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1PatchNetworkRestrictions">(
      operationDefinitions.v1PatchNetworkRestrictions,
      input,
    );
  });

export const v1PauseAProject = (
  input: typeof operationDefinitions.v1PauseAProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1PauseAProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1PauseAProject">(operationDefinitions.v1PauseAProject, input);
  });

export const v1PushABranch = (
  input: typeof operationDefinitions.v1PushABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1PushABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1PushABranch">(operationDefinitions.v1PushABranch, input);
  });

export const v1ReadOnlyQuery = (
  input: typeof operationDefinitions.v1ReadOnlyQuery.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ReadOnlyQuery.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ReadOnlyQuery">(operationDefinitions.v1ReadOnlyQuery, input);
  });

export const v1RemoveAReadReplica = (
  input: typeof operationDefinitions.v1RemoveAReadReplica.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RemoveAReadReplica.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RemoveAReadReplica">(
      operationDefinitions.v1RemoveAReadReplica,
      input,
    );
  });

export const v1RemoveProjectAddon = (
  input: typeof operationDefinitions.v1RemoveProjectAddon.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RemoveProjectAddon.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RemoveProjectAddon">(
      operationDefinitions.v1RemoveProjectAddon,
      input,
    );
  });

export const v1RemoveProjectSigningKey = (
  input: typeof operationDefinitions.v1RemoveProjectSigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RemoveProjectSigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RemoveProjectSigningKey">(
      operationDefinitions.v1RemoveProjectSigningKey,
      input,
    );
  });

export const v1ResetABranch = (
  input: typeof operationDefinitions.v1ResetABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ResetABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ResetABranch">(operationDefinitions.v1ResetABranch, input);
  });

export const v1RestoreABranch = (
  input: typeof operationDefinitions.v1RestoreABranch.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RestoreABranch.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RestoreABranch">(operationDefinitions.v1RestoreABranch, input);
  });

export const v1RestoreAProject = (
  input: typeof operationDefinitions.v1RestoreAProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RestoreAProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RestoreAProject">(
      operationDefinitions.v1RestoreAProject,
      input,
    );
  });

export const v1RestorePitrBackup = (
  input: typeof operationDefinitions.v1RestorePitrBackup.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RestorePitrBackup.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RestorePitrBackup">(
      operationDefinitions.v1RestorePitrBackup,
      input,
    );
  });

export const v1RevokeToken = (
  input: typeof operationDefinitions.v1RevokeToken.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RevokeToken.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RevokeToken">(operationDefinitions.v1RevokeToken, input);
  });

export const v1RollbackMigrations = (
  input: typeof operationDefinitions.v1RollbackMigrations.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RollbackMigrations.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RollbackMigrations">(
      operationDefinitions.v1RollbackMigrations,
      input,
    );
  });

export const v1RunAQuery = (
  input: typeof operationDefinitions.v1RunAQuery.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1RunAQuery.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1RunAQuery">(operationDefinitions.v1RunAQuery, input);
  });

export const v1SetupAReadReplica = (
  input: typeof operationDefinitions.v1SetupAReadReplica.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1SetupAReadReplica.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1SetupAReadReplica">(
      operationDefinitions.v1SetupAReadReplica,
      input,
    );
  });

export const v1ShutdownRealtime = (
  input: typeof operationDefinitions.v1ShutdownRealtime.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1ShutdownRealtime.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1ShutdownRealtime">(
      operationDefinitions.v1ShutdownRealtime,
      input,
    );
  });

export const v1Undo = (
  input: typeof operationDefinitions.v1Undo.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1Undo.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1Undo">(operationDefinitions.v1Undo, input);
  });

export const v1UpdateABranchConfig = (
  input: typeof operationDefinitions.v1UpdateABranchConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateABranchConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateABranchConfig">(
      operationDefinitions.v1UpdateABranchConfig,
      input,
    );
  });

export const v1UpdateAFunction = (
  input: typeof operationDefinitions.v1UpdateAFunction.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateAFunction.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateAFunction">(
      operationDefinitions.v1UpdateAFunction,
      input,
    );
  });

export const v1UpdateAProject = (
  input: typeof operationDefinitions.v1UpdateAProject.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateAProject.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateAProject">(operationDefinitions.v1UpdateAProject, input);
  });

export const v1UpdateASsoProvider = (
  input: typeof operationDefinitions.v1UpdateASsoProvider.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateASsoProvider.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateASsoProvider">(
      operationDefinitions.v1UpdateASsoProvider,
      input,
    );
  });

export const v1UpdateActionRunStatus = (
  input: typeof operationDefinitions.v1UpdateActionRunStatus.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateActionRunStatus.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateActionRunStatus">(
      operationDefinitions.v1UpdateActionRunStatus,
      input,
    );
  });

export const v1UpdateAuthServiceConfig = (
  input: typeof operationDefinitions.v1UpdateAuthServiceConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateAuthServiceConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateAuthServiceConfig">(
      operationDefinitions.v1UpdateAuthServiceConfig,
      input,
    );
  });

export const v1UpdateDatabasePassword = (
  input: typeof operationDefinitions.v1UpdateDatabasePassword.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateDatabasePassword.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateDatabasePassword">(
      operationDefinitions.v1UpdateDatabasePassword,
      input,
    );
  });

export const v1UpdateHostnameConfig = (
  input: typeof operationDefinitions.v1UpdateHostnameConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateHostnameConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateHostnameConfig">(
      operationDefinitions.v1UpdateHostnameConfig,
      input,
    );
  });

export const v1UpdateJitAccess = (
  input: typeof operationDefinitions.v1UpdateJitAccess.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateJitAccess.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateJitAccess">(
      operationDefinitions.v1UpdateJitAccess,
      input,
    );
  });

export const v1UpdateJitAccessConfig = (
  input: typeof operationDefinitions.v1UpdateJitAccessConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateJitAccessConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateJitAccessConfig">(
      operationDefinitions.v1UpdateJitAccessConfig,
      input,
    );
  });

export const v1UpdateNetworkRestrictions = (
  input: typeof operationDefinitions.v1UpdateNetworkRestrictions.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateNetworkRestrictions.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateNetworkRestrictions">(
      operationDefinitions.v1UpdateNetworkRestrictions,
      input,
    );
  });

export const v1UpdatePgsodiumConfig = (
  input: typeof operationDefinitions.v1UpdatePgsodiumConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdatePgsodiumConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdatePgsodiumConfig">(
      operationDefinitions.v1UpdatePgsodiumConfig,
      input,
    );
  });

export const v1UpdatePoolerConfig = (
  input: typeof operationDefinitions.v1UpdatePoolerConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdatePoolerConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdatePoolerConfig">(
      operationDefinitions.v1UpdatePoolerConfig,
      input,
    );
  });

export const v1UpdatePostgresConfig = (
  input: typeof operationDefinitions.v1UpdatePostgresConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdatePostgresConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdatePostgresConfig">(
      operationDefinitions.v1UpdatePostgresConfig,
      input,
    );
  });

export const v1UpdatePostgrestServiceConfig = (
  input: typeof operationDefinitions.v1UpdatePostgrestServiceConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdatePostgrestServiceConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdatePostgrestServiceConfig">(
      operationDefinitions.v1UpdatePostgrestServiceConfig,
      input,
    );
  });

export const v1UpdateProjectApiKey = (
  input: typeof operationDefinitions.v1UpdateProjectApiKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateProjectApiKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateProjectApiKey">(
      operationDefinitions.v1UpdateProjectApiKey,
      input,
    );
  });

export const v1UpdateProjectLegacyApiKeys = (
  input: typeof operationDefinitions.v1UpdateProjectLegacyApiKeys.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateProjectLegacyApiKeys.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateProjectLegacyApiKeys">(
      operationDefinitions.v1UpdateProjectLegacyApiKeys,
      input,
    );
  });

export const v1UpdateProjectSigningKey = (
  input: typeof operationDefinitions.v1UpdateProjectSigningKey.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateProjectSigningKey.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateProjectSigningKey">(
      operationDefinitions.v1UpdateProjectSigningKey,
      input,
    );
  });

export const v1UpdateRealtimeConfig = (
  input: typeof operationDefinitions.v1UpdateRealtimeConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateRealtimeConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateRealtimeConfig">(
      operationDefinitions.v1UpdateRealtimeConfig,
      input,
    );
  });

export const v1UpdateSslEnforcementConfig = (
  input: typeof operationDefinitions.v1UpdateSslEnforcementConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateSslEnforcementConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateSslEnforcementConfig">(
      operationDefinitions.v1UpdateSslEnforcementConfig,
      input,
    );
  });

export const v1UpdateStorageConfig = (
  input: typeof operationDefinitions.v1UpdateStorageConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpdateStorageConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpdateStorageConfig">(
      operationDefinitions.v1UpdateStorageConfig,
      input,
    );
  });

export const v1UpgradePostgresVersion = (
  input: typeof operationDefinitions.v1UpgradePostgresVersion.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpgradePostgresVersion.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpgradePostgresVersion">(
      operationDefinitions.v1UpgradePostgresVersion,
      input,
    );
  });

export const v1UpsertAMigration = (
  input: typeof operationDefinitions.v1UpsertAMigration.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1UpsertAMigration.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1UpsertAMigration">(
      operationDefinitions.v1UpsertAMigration,
      input,
    );
  });

export const v1VerifyDnsConfig = (
  input: typeof operationDefinitions.v1VerifyDnsConfig.inputSchema.Type,
): Effect.Effect<
  typeof operationDefinitions.v1VerifyDnsConfig.outputSchema.Type,
  SupabaseApiError,
  SupabaseApiClient
> =>
  Effect.gen(function* () {
    const client = yield* SupabaseApiClient;
    return yield* client.execute<"v1VerifyDnsConfig">(
      operationDefinitions.v1VerifyDnsConfig,
      input,
    );
  });

export const effectOperations = {
  v1ActivateCustomHostname,
  v1ActivateVanitySubdomainConfig,
  v1ApplyAMigration,
  v1ApplyProjectAddon,
  v1AuthorizeJitAccess,
  v1AuthorizeUser,
  v1BulkCreateSecrets,
  v1BulkDeleteSecrets,
  v1BulkUpdateFunctions,
  v1CancelAProjectRestoration,
  v1CheckVanitySubdomainAvailability,
  v1ClaimProjectForOrganization,
  v1CountActionRuns,
  v1CreateABranch,
  v1CreateAFunction,
  v1CreateAProject,
  v1CreateASsoProvider,
  v1CreateAnOrganization,
  v1CreateLegacySigningKey,
  v1CreateLoginRole,
  v1CreateProjectApiKey,
  v1CreateProjectClaimToken,
  v1CreateProjectSigningKey,
  v1CreateProjectTpaIntegration,
  v1CreateRestorePoint,
  v1DeactivateVanitySubdomainConfig,
  v1DeleteHostnameConfig,
  v1DeleteABranch,
  v1DeleteAFunction,
  v1DeleteAProject,
  v1DeleteASsoProvider,
  v1DeleteJitAccess,
  v1DeleteLoginRoles,
  v1DeleteNetworkBans,
  v1DeleteProjectApiKey,
  v1DeleteProjectClaimToken,
  v1DeleteProjectTpaIntegration,
  v1DeployAFunction,
  v1DiffABranch,
  v1DisablePreviewBranching,
  v1DisableReadonlyModeTemporarily,
  v1EnableDatabaseWebhook,
  v1ExchangeOauthToken,
  v1GenerateTypescriptTypes,
  v1GetABranch,
  v1GetABranchConfig,
  v1GetAFunction,
  v1GetAFunctionBody,
  v1GetAMigration,
  v1GetASnippet,
  v1GetASsoProvider,
  v1GetActionRun,
  v1GetActionRunLogs,
  v1GetAllProjectsForOrganization,
  v1GetAnOrganization,
  v1GetAuthServiceConfig,
  v1GetAvailableRegions,
  v1GetDatabaseDisk,
  v1GetDatabaseMetadata,
  v1GetDiskUtilization,
  v1GetHostnameConfig,
  v1GetJitAccess,
  v1GetJitAccessConfig,
  v1GetLegacySigningKey,
  v1GetNetworkRestrictions,
  v1GetOrganizationProjectClaim,
  v1GetPerformanceAdvisors,
  v1GetPgsodiumConfig,
  v1GetPoolerConfig,
  v1GetPostgresConfig,
  v1GetPostgresUpgradeEligibility,
  v1GetPostgresUpgradeStatus,
  v1GetPostgrestServiceConfig,
  v1GetProject,
  v1GetProjectApiKey,
  v1GetProjectApiKeys,
  v1GetProjectClaimToken,
  v1GetProjectDiskAutoscaleConfig,
  v1GetProjectFunctionCombinedStats,
  v1GetProjectLegacyApiKeys,
  v1GetProjectLogs,
  v1GetProjectPgbouncerConfig,
  v1GetProjectSigningKey,
  v1GetProjectSigningKeys,
  v1GetProjectTpaIntegration,
  v1GetProjectUsageApiCount,
  v1GetProjectUsageRequestCount,
  v1GetReadonlyModeStatus,
  v1GetRealtimeConfig,
  v1GetRestorePoint,
  v1GetSecurityAdvisors,
  v1GetServicesHealth,
  v1GetSslEnforcementConfig,
  v1GetStorageConfig,
  v1GetVanitySubdomainConfig,
  v1ListActionRuns,
  v1ListAllBackups,
  v1ListAllBranches,
  v1ListAllBuckets,
  v1ListAllFunctions,
  v1ListAllNetworkBans,
  v1ListAllNetworkBansEnriched,
  v1ListAllOrganizations,
  v1ListAllProjects,
  v1ListAllSecrets,
  v1ListAllSnippets,
  v1ListAllSsoProvider,
  v1ListAvailableRestoreVersions,
  v1ListJitAccess,
  v1ListMigrationHistory,
  v1ListOrganizationMembers,
  v1ListProjectAddons,
  v1ListProjectTpaIntegrations,
  v1MergeABranch,
  v1ModifyDatabaseDisk,
  v1OauthAuthorizeProjectClaim,
  v1PatchAMigration,
  v1PatchNetworkRestrictions,
  v1PauseAProject,
  v1PushABranch,
  v1ReadOnlyQuery,
  v1RemoveAReadReplica,
  v1RemoveProjectAddon,
  v1RemoveProjectSigningKey,
  v1ResetABranch,
  v1RestoreABranch,
  v1RestoreAProject,
  v1RestorePitrBackup,
  v1RevokeToken,
  v1RollbackMigrations,
  v1RunAQuery,
  v1SetupAReadReplica,
  v1ShutdownRealtime,
  v1Undo,
  v1UpdateABranchConfig,
  v1UpdateAFunction,
  v1UpdateAProject,
  v1UpdateASsoProvider,
  v1UpdateActionRunStatus,
  v1UpdateAuthServiceConfig,
  v1UpdateDatabasePassword,
  v1UpdateHostnameConfig,
  v1UpdateJitAccess,
  v1UpdateJitAccessConfig,
  v1UpdateNetworkRestrictions,
  v1UpdatePgsodiumConfig,
  v1UpdatePoolerConfig,
  v1UpdatePostgresConfig,
  v1UpdatePostgrestServiceConfig,
  v1UpdateProjectApiKey,
  v1UpdateProjectLegacyApiKeys,
  v1UpdateProjectSigningKey,
  v1UpdateRealtimeConfig,
  v1UpdateSslEnforcementConfig,
  v1UpdateStorageConfig,
  v1UpgradePostgresVersion,
  v1UpsertAMigration,
  v1VerifyDnsConfig,
};
