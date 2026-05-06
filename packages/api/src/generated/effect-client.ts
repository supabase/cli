import { Effect, Schema } from "effect";

import type { EffectClient } from "../internal/effect-client.ts";
import type { SupabaseApiError } from "../internal/client.ts";
import { SupabaseApiClient } from "../internal/client.ts";
import { operationDefinitions } from "./contracts.ts";

export const versionedEffectOperations = {
  v1: {
    activateCustomHostname: (
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
      }),
    activateVanitySubdomainConfig: (
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
      }),
    applyAMigration: (
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
      }),
    applyProjectAddon: (
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
      }),
    authorizeJitAccess: (
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
      }),
    authorizeUser: (
      input: typeof operationDefinitions.v1AuthorizeUser.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1AuthorizeUser.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1AuthorizeUser">(
          operationDefinitions.v1AuthorizeUser,
          input,
        );
      }),
    bulkCreateSecrets: (
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
      }),
    bulkDeleteSecrets: (
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
      }),
    bulkUpdateFunctions: (
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
      }),
    cancelAProjectRestoration: (
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
      }),
    checkVanitySubdomainAvailability: (
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
      }),
    claimProjectForOrganization: (
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
      }),
    countActionRuns: (
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
      }),
    createABranch: (
      input: typeof operationDefinitions.v1CreateABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1CreateABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1CreateABranch">(
          operationDefinitions.v1CreateABranch,
          input,
        );
      }),
    createAFunction: (
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
      }),
    createAProject: (
      input: typeof operationDefinitions.v1CreateAProject.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1CreateAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1CreateAProject">(
          operationDefinitions.v1CreateAProject,
          input,
        );
      }),
    createASsoProvider: (
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
      }),
    createAnOrganization: (
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
      }),
    createLegacySigningKey: (
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
      }),
    createLoginRole: (
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
      }),
    createProjectApiKey: (
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
      }),
    createProjectClaimToken: (
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
      }),
    createProjectSigningKey: (
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
      }),
    createProjectTpaIntegration: (
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
      }),
    createRestorePoint: (
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
      }),
    deactivateVanitySubdomainConfig: (
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
      }),
    deleteHostnameConfig: (
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
      }),
    deleteABranch: (
      input: typeof operationDefinitions.v1DeleteABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1DeleteABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1DeleteABranch">(
          operationDefinitions.v1DeleteABranch,
          input,
        );
      }),
    deleteAFunction: (
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
      }),
    deleteAProject: (
      input: typeof operationDefinitions.v1DeleteAProject.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1DeleteAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1DeleteAProject">(
          operationDefinitions.v1DeleteAProject,
          input,
        );
      }),
    deleteASsoProvider: (
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
      }),
    deleteJitAccess: (
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
      }),
    deleteLoginRoles: (
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
      }),
    deleteNetworkBans: (
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
      }),
    deleteProjectApiKey: (
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
      }),
    deleteProjectClaimToken: (
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
      }),
    deleteProjectTpaIntegration: (
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
      }),
    deployAFunction: (
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
      }),
    diffABranch: (
      input: typeof operationDefinitions.v1DiffABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1DiffABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1DiffABranch">(operationDefinitions.v1DiffABranch, input);
      }),
    disablePreviewBranching: (
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
      }),
    disableReadonlyModeTemporarily: (
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
      }),
    enableDatabaseWebhook: (
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
      }),
    exchangeOauthToken: (
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
      }),
    generateTypescriptTypes: (
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
      }),
    getABranch: (
      input: typeof operationDefinitions.v1GetABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetABranch">(operationDefinitions.v1GetABranch, input);
      }),
    getABranchConfig: (
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
      }),
    getAFunction: (
      input: typeof operationDefinitions.v1GetAFunction.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetAFunction.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetAFunction">(operationDefinitions.v1GetAFunction, input);
      }),
    getAFunctionBody: (
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
      }),
    getAMigration: (
      input: typeof operationDefinitions.v1GetAMigration.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetAMigration.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetAMigration">(
          operationDefinitions.v1GetAMigration,
          input,
        );
      }),
    getASnippet: (
      input: typeof operationDefinitions.v1GetASnippet.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetASnippet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetASnippet">(operationDefinitions.v1GetASnippet, input);
      }),
    getASsoProvider: (
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
      }),
    getActionRun: (
      input: typeof operationDefinitions.v1GetActionRun.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetActionRun.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetActionRun">(operationDefinitions.v1GetActionRun, input);
      }),
    getActionRunLogs: (
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
      }),
    getAllProjectsForOrganization: (
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
      }),
    getAnOrganization: (
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
      }),
    getAuthServiceConfig: (
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
      }),
    getAvailableRegions: (
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
      }),
    getDatabaseDisk: (
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
      }),
    getDatabaseMetadata: (
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
      }),
    getDatabaseOpenapi: (
      input: typeof operationDefinitions.v1GetDatabaseOpenapi.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetDatabaseOpenapi.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetDatabaseOpenapi">(
          operationDefinitions.v1GetDatabaseOpenapi,
          input,
        );
      }),
    getDiskUtilization: (
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
      }),
    getHostnameConfig: (
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
      }),
    getJitAccess: (
      input: typeof operationDefinitions.v1GetJitAccess.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetJitAccess">(operationDefinitions.v1GetJitAccess, input);
      }),
    getJitAccessConfig: (
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
      }),
    getLegacySigningKey: (
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
      }),
    getNetworkRestrictions: (
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
      }),
    getOrganizationEntitlements: (
      input: typeof operationDefinitions.v1GetOrganizationEntitlements.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetOrganizationEntitlements.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetOrganizationEntitlements">(
          operationDefinitions.v1GetOrganizationEntitlements,
          input,
        );
      }),
    getOrganizationProjectClaim: (
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
      }),
    getPerformanceAdvisors: (
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
      }),
    getPgsodiumConfig: (
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
      }),
    getPoolerConfig: (
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
      }),
    getPostgresConfig: (
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
      }),
    getPostgresUpgradeEligibility: (
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
      }),
    getPostgresUpgradeStatus: (
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
      }),
    getPostgrestServiceConfig: (
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
      }),
    getProfile: (): Effect.Effect<
      typeof operationDefinitions.v1GetProfile.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProfile">(operationDefinitions.v1GetProfile, {});
      }),
    getProject: (
      input: typeof operationDefinitions.v1GetProject.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProject">(operationDefinitions.v1GetProject, input);
      }),
    getProjectApiKey: (
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
      }),
    getProjectApiKeys: (
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
      }),
    getProjectClaimToken: (
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
      }),
    getProjectDiskAutoscaleConfig: (
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
      }),
    getProjectFunctionCombinedStats: (
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
      }),
    getProjectLegacyApiKeys: (
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
      }),
    getProjectLogs: (
      input: typeof operationDefinitions.v1GetProjectLogs.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetProjectLogs.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProjectLogs">(
          operationDefinitions.v1GetProjectLogs,
          input,
        );
      }),
    getProjectPgbouncerConfig: (
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
      }),
    getProjectSigningKey: (
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
      }),
    getProjectSigningKeys: (
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
      }),
    getProjectTpaIntegration: (
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
      }),
    getProjectUsageApiCount: (
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
      }),
    getProjectUsageRequestCount: (
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
      }),
    getReadonlyModeStatus: (
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
      }),
    getRealtimeConfig: (
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
      }),
    getRestorePoint: (
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
      }),
    getSecurityAdvisors: (
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
      }),
    getServicesHealth: (
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
      }),
    getSslEnforcementConfig: (
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
      }),
    getStorageConfig: (
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
      }),
    getVanitySubdomainConfig: (
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
      }),
    listActionRuns: (
      input: typeof operationDefinitions.v1ListActionRuns.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListActionRuns.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListActionRuns">(
          operationDefinitions.v1ListActionRuns,
          input,
        );
      }),
    listAllBackups: (
      input: typeof operationDefinitions.v1ListAllBackups.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListAllBackups.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllBackups">(
          operationDefinitions.v1ListAllBackups,
          input,
        );
      }),
    listAllBranches: (
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
      }),
    listAllBuckets: (
      input: typeof operationDefinitions.v1ListAllBuckets.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListAllBuckets.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllBuckets">(
          operationDefinitions.v1ListAllBuckets,
          input,
        );
      }),
    listAllFunctions: (
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
      }),
    listAllNetworkBans: (
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
      }),
    listAllNetworkBansEnriched: (
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
      }),
    listAllOrganizations: (): Effect.Effect<
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
      }),
    listAllProjects: (): Effect.Effect<
      typeof operationDefinitions.v1ListAllProjects.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllProjects">(
          operationDefinitions.v1ListAllProjects,
          {},
        );
      }),
    listAllSecrets: (
      input: typeof operationDefinitions.v1ListAllSecrets.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListAllSecrets.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllSecrets">(
          operationDefinitions.v1ListAllSecrets,
          input,
        );
      }),
    listAllSnippets: (
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
      }),
    listAllSsoProvider: (
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
      }),
    listAvailableRestoreVersions: (
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
      }),
    listJitAccess: (
      input: typeof operationDefinitions.v1ListJitAccess.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListJitAccess">(
          operationDefinitions.v1ListJitAccess,
          input,
        );
      }),
    listMigrationHistory: (
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
      }),
    listOrganizationMembers: (
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
      }),
    listProjectAddons: (
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
      }),
    listProjectTpaIntegrations: (
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
      }),
    mergeABranch: (
      input: typeof operationDefinitions.v1MergeABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1MergeABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1MergeABranch">(operationDefinitions.v1MergeABranch, input);
      }),
    modifyDatabaseDisk: (
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
      }),
    oauthAuthorizeProjectClaim: (
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
      }),
    patchAMigration: (
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
      }),
    patchNetworkRestrictions: (
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
      }),
    pauseAProject: (
      input: typeof operationDefinitions.v1PauseAProject.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1PauseAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1PauseAProject">(
          operationDefinitions.v1PauseAProject,
          input,
        );
      }),
    pushABranch: (
      input: typeof operationDefinitions.v1PushABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1PushABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1PushABranch">(operationDefinitions.v1PushABranch, input);
      }),
    readOnlyQuery: (
      input: typeof operationDefinitions.v1ReadOnlyQuery.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ReadOnlyQuery.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ReadOnlyQuery">(
          operationDefinitions.v1ReadOnlyQuery,
          input,
        );
      }),
    removeAReadReplica: (
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
      }),
    removeProjectAddon: (
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
      }),
    removeProjectSigningKey: (
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
      }),
    resetABranch: (
      input: typeof operationDefinitions.v1ResetABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1ResetABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ResetABranch">(operationDefinitions.v1ResetABranch, input);
      }),
    restoreABranch: (
      input: typeof operationDefinitions.v1RestoreABranch.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1RestoreABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RestoreABranch">(
          operationDefinitions.v1RestoreABranch,
          input,
        );
      }),
    restoreAProject: (
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
      }),
    restorePitrBackup: (
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
      }),
    revokeToken: (
      input: typeof operationDefinitions.v1RevokeToken.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1RevokeToken.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RevokeToken">(operationDefinitions.v1RevokeToken, input);
      }),
    rollbackMigrations: (
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
      }),
    runAQuery: (
      input: typeof operationDefinitions.v1RunAQuery.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1RunAQuery.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RunAQuery">(operationDefinitions.v1RunAQuery, input);
      }),
    setupAReadReplica: (
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
      }),
    shutdownRealtime: (
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
      }),
    undo: (
      input: typeof operationDefinitions.v1Undo.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1Undo.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1Undo">(operationDefinitions.v1Undo, input);
      }),
    updateABranchConfig: (
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
      }),
    updateAFunction: (
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
      }),
    updateAProject: (
      input: typeof operationDefinitions.v1UpdateAProject.inputSchema.Type,
    ): Effect.Effect<
      typeof operationDefinitions.v1UpdateAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1UpdateAProject">(
          operationDefinitions.v1UpdateAProject,
          input,
        );
      }),
    updateASsoProvider: (
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
      }),
    updateActionRunStatus: (
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
      }),
    updateAuthServiceConfig: (
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
      }),
    updateDatabasePassword: (
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
      }),
    updateHostnameConfig: (
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
      }),
    updateJitAccess: (
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
      }),
    updateJitAccessConfig: (
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
      }),
    updateNetworkRestrictions: (
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
      }),
    updatePgsodiumConfig: (
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
      }),
    updatePoolerConfig: (
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
      }),
    updatePostgresConfig: (
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
      }),
    updatePostgrestServiceConfig: (
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
      }),
    updateProjectApiKey: (
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
      }),
    updateProjectLegacyApiKeys: (
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
      }),
    updateProjectSigningKey: (
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
      }),
    updateRealtimeConfig: (
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
      }),
    updateSslEnforcementConfig: (
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
      }),
    updateStorageConfig: (
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
      }),
    upgradePostgresVersion: (
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
      }),
    upsertAMigration: (
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
      }),
    verifyDnsConfig: (
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
      }),
  },
} as const;

export type GeneratedEffectOperations = typeof versionedEffectOperations;
type GeneratedApiClient = EffectClient<GeneratedEffectOperations>;

export function executeApiClientOperation(
  operationId: keyof typeof operationDefinitions,
  api: GeneratedApiClient,
  input: unknown,
) {
  switch (operationId) {
    case "v1ActivateCustomHostname":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ActivateCustomHostname.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.activateCustomHostname(decoded)));
    case "v1ActivateVanitySubdomainConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1ActivateVanitySubdomainConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.activateVanitySubdomainConfig(decoded)));
    case "v1ApplyAMigration":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ApplyAMigration.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.applyAMigration(decoded)));
    case "v1ApplyProjectAddon":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ApplyProjectAddon.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.applyProjectAddon(decoded)));
    case "v1AuthorizeJitAccess":
      return Schema.decodeUnknownEffect(operationDefinitions.v1AuthorizeJitAccess.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.authorizeJitAccess(decoded)));
    case "v1AuthorizeUser":
      return Schema.decodeUnknownEffect(operationDefinitions.v1AuthorizeUser.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.authorizeUser(decoded)));
    case "v1BulkCreateSecrets":
      return Schema.decodeUnknownEffect(operationDefinitions.v1BulkCreateSecrets.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.bulkCreateSecrets(decoded)));
    case "v1BulkDeleteSecrets":
      return Schema.decodeUnknownEffect(operationDefinitions.v1BulkDeleteSecrets.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.bulkDeleteSecrets(decoded)));
    case "v1BulkUpdateFunctions":
      return Schema.decodeUnknownEffect(operationDefinitions.v1BulkUpdateFunctions.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.bulkUpdateFunctions(decoded)));
    case "v1CancelAProjectRestoration":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1CancelAProjectRestoration.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.cancelAProjectRestoration(decoded)));
    case "v1CheckVanitySubdomainAvailability":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1CheckVanitySubdomainAvailability.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.checkVanitySubdomainAvailability(decoded)));
    case "v1ClaimProjectForOrganization":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1ClaimProjectForOrganization.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.claimProjectForOrganization(decoded)));
    case "v1CountActionRuns":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CountActionRuns.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.countActionRuns(decoded)));
    case "v1CreateABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateABranch.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createABranch(decoded)));
    case "v1CreateAFunction":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateAFunction.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createAFunction(decoded)));
    case "v1CreateAProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateAProject.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createAProject(decoded)));
    case "v1CreateASsoProvider":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateASsoProvider.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createASsoProvider(decoded)));
    case "v1CreateAnOrganization":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateAnOrganization.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createAnOrganization(decoded)));
    case "v1CreateLegacySigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateLegacySigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createLegacySigningKey(decoded)));
    case "v1CreateLoginRole":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateLoginRole.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createLoginRole(decoded)));
    case "v1CreateProjectApiKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateProjectApiKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createProjectApiKey(decoded)));
    case "v1CreateProjectClaimToken":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateProjectClaimToken.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createProjectClaimToken(decoded)));
    case "v1CreateProjectSigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateProjectSigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createProjectSigningKey(decoded)));
    case "v1CreateProjectTpaIntegration":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1CreateProjectTpaIntegration.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.createProjectTpaIntegration(decoded)));
    case "v1CreateRestorePoint":
      return Schema.decodeUnknownEffect(operationDefinitions.v1CreateRestorePoint.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.createRestorePoint(decoded)));
    case "v1DeactivateVanitySubdomainConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1DeactivateVanitySubdomainConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.deactivateVanitySubdomainConfig(decoded)));
    case "v1DeleteHostnameConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteHostnameConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteHostnameConfig(decoded)));
    case "v1DeleteABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteABranch.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteABranch(decoded)));
    case "v1DeleteAFunction":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteAFunction.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteAFunction(decoded)));
    case "v1DeleteAProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteAProject.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteAProject(decoded)));
    case "v1DeleteASsoProvider":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteASsoProvider.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteASsoProvider(decoded)));
    case "v1DeleteJitAccess":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteJitAccess.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteJitAccess(decoded)));
    case "v1DeleteLoginRoles":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteLoginRoles.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteLoginRoles(decoded)));
    case "v1DeleteNetworkBans":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteNetworkBans.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteNetworkBans(decoded)));
    case "v1DeleteProjectApiKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteProjectApiKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteProjectApiKey(decoded)));
    case "v1DeleteProjectClaimToken":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeleteProjectClaimToken.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deleteProjectClaimToken(decoded)));
    case "v1DeleteProjectTpaIntegration":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1DeleteProjectTpaIntegration.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.deleteProjectTpaIntegration(decoded)));
    case "v1DeployAFunction":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DeployAFunction.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.deployAFunction(decoded)));
    case "v1DiffABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DiffABranch.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.diffABranch(decoded)),
      );
    case "v1DisablePreviewBranching":
      return Schema.decodeUnknownEffect(operationDefinitions.v1DisablePreviewBranching.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.disablePreviewBranching(decoded)));
    case "v1DisableReadonlyModeTemporarily":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1DisableReadonlyModeTemporarily.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.disableReadonlyModeTemporarily(decoded)));
    case "v1EnableDatabaseWebhook":
      return Schema.decodeUnknownEffect(operationDefinitions.v1EnableDatabaseWebhook.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.enableDatabaseWebhook(decoded)));
    case "v1ExchangeOauthToken":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ExchangeOauthToken.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.exchangeOauthToken(decoded)));
    case "v1GenerateTypescriptTypes":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GenerateTypescriptTypes.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.generateTypescriptTypes(decoded)));
    case "v1GetABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetABranch.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.getABranch(decoded)),
      );
    case "v1GetABranchConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetABranchConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getABranchConfig(decoded)));
    case "v1GetAFunction":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAFunction.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAFunction(decoded)));
    case "v1GetAFunctionBody":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAFunctionBody.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAFunctionBody(decoded)));
    case "v1GetAMigration":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAMigration.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAMigration(decoded)));
    case "v1GetASnippet":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetASnippet.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.getASnippet(decoded)),
      );
    case "v1GetASsoProvider":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetASsoProvider.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getASsoProvider(decoded)));
    case "v1GetActionRun":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetActionRun.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getActionRun(decoded)));
    case "v1GetActionRunLogs":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetActionRunLogs.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getActionRunLogs(decoded)));
    case "v1GetAllProjectsForOrganization":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetAllProjectsForOrganization.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getAllProjectsForOrganization(decoded)));
    case "v1GetAnOrganization":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAnOrganization.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAnOrganization(decoded)));
    case "v1GetAuthServiceConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAuthServiceConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAuthServiceConfig(decoded)));
    case "v1GetAvailableRegions":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetAvailableRegions.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getAvailableRegions(decoded)));
    case "v1GetDatabaseDisk":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetDatabaseDisk.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getDatabaseDisk(decoded)));
    case "v1GetDatabaseMetadata":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetDatabaseMetadata.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getDatabaseMetadata(decoded)));
    case "v1GetDatabaseOpenapi":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetDatabaseOpenapi.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getDatabaseOpenapi(decoded)));
    case "v1GetDiskUtilization":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetDiskUtilization.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getDiskUtilization(decoded)));
    case "v1GetHostnameConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetHostnameConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getHostnameConfig(decoded)));
    case "v1GetJitAccess":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetJitAccess.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getJitAccess(decoded)));
    case "v1GetJitAccessConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetJitAccessConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getJitAccessConfig(decoded)));
    case "v1GetLegacySigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetLegacySigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getLegacySigningKey(decoded)));
    case "v1GetNetworkRestrictions":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetNetworkRestrictions.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getNetworkRestrictions(decoded)));
    case "v1GetOrganizationEntitlements":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetOrganizationEntitlements.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getOrganizationEntitlements(decoded)));
    case "v1GetOrganizationProjectClaim":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetOrganizationProjectClaim.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getOrganizationProjectClaim(decoded)));
    case "v1GetPerformanceAdvisors":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetPerformanceAdvisors.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getPerformanceAdvisors(decoded)));
    case "v1GetPgsodiumConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetPgsodiumConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getPgsodiumConfig(decoded)));
    case "v1GetPoolerConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetPoolerConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getPoolerConfig(decoded)));
    case "v1GetPostgresConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetPostgresConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getPostgresConfig(decoded)));
    case "v1GetPostgresUpgradeEligibility":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetPostgresUpgradeEligibility.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getPostgresUpgradeEligibility(decoded)));
    case "v1GetPostgresUpgradeStatus":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetPostgresUpgradeStatus.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getPostgresUpgradeStatus(decoded)));
    case "v1GetPostgrestServiceConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetPostgrestServiceConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getPostgrestServiceConfig(decoded)));
    case "v1GetProfile":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProfile.inputSchema)(input).pipe(
        Effect.flatMap((_decoded) => api.v1.getProfile()),
      );
    case "v1GetProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProject.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.getProject(decoded)),
      );
    case "v1GetProjectApiKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectApiKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectApiKey(decoded)));
    case "v1GetProjectApiKeys":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectApiKeys.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectApiKeys(decoded)));
    case "v1GetProjectClaimToken":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectClaimToken.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectClaimToken(decoded)));
    case "v1GetProjectDiskAutoscaleConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetProjectDiskAutoscaleConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getProjectDiskAutoscaleConfig(decoded)));
    case "v1GetProjectFunctionCombinedStats":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetProjectFunctionCombinedStats.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getProjectFunctionCombinedStats(decoded)));
    case "v1GetProjectLegacyApiKeys":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectLegacyApiKeys.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectLegacyApiKeys(decoded)));
    case "v1GetProjectLogs":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectLogs.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectLogs(decoded)));
    case "v1GetProjectPgbouncerConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetProjectPgbouncerConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getProjectPgbouncerConfig(decoded)));
    case "v1GetProjectSigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectSigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectSigningKey(decoded)));
    case "v1GetProjectSigningKeys":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectSigningKeys.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectSigningKeys(decoded)));
    case "v1GetProjectTpaIntegration":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetProjectTpaIntegration.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getProjectTpaIntegration(decoded)));
    case "v1GetProjectUsageApiCount":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetProjectUsageApiCount.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getProjectUsageApiCount(decoded)));
    case "v1GetProjectUsageRequestCount":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetProjectUsageRequestCount.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getProjectUsageRequestCount(decoded)));
    case "v1GetReadonlyModeStatus":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetReadonlyModeStatus.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getReadonlyModeStatus(decoded)));
    case "v1GetRealtimeConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetRealtimeConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getRealtimeConfig(decoded)));
    case "v1GetRestorePoint":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetRestorePoint.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getRestorePoint(decoded)));
    case "v1GetSecurityAdvisors":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetSecurityAdvisors.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getSecurityAdvisors(decoded)));
    case "v1GetServicesHealth":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetServicesHealth.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getServicesHealth(decoded)));
    case "v1GetSslEnforcementConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetSslEnforcementConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getSslEnforcementConfig(decoded)));
    case "v1GetStorageConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1GetStorageConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.getStorageConfig(decoded)));
    case "v1GetVanitySubdomainConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1GetVanitySubdomainConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.getVanitySubdomainConfig(decoded)));
    case "v1ListActionRuns":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListActionRuns.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listActionRuns(decoded)));
    case "v1ListAllBackups":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllBackups.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllBackups(decoded)));
    case "v1ListAllBranches":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllBranches.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllBranches(decoded)));
    case "v1ListAllBuckets":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllBuckets.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllBuckets(decoded)));
    case "v1ListAllFunctions":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllFunctions.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllFunctions(decoded)));
    case "v1ListAllNetworkBans":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllNetworkBans.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllNetworkBans(decoded)));
    case "v1ListAllNetworkBansEnriched":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1ListAllNetworkBansEnriched.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.listAllNetworkBansEnriched(decoded)));
    case "v1ListAllOrganizations":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllOrganizations.inputSchema)(
        input,
      ).pipe(Effect.flatMap((_decoded) => api.v1.listAllOrganizations()));
    case "v1ListAllProjects":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllProjects.inputSchema)(
        input,
      ).pipe(Effect.flatMap((_decoded) => api.v1.listAllProjects()));
    case "v1ListAllSecrets":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllSecrets.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllSecrets(decoded)));
    case "v1ListAllSnippets":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllSnippets.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllSnippets(decoded)));
    case "v1ListAllSsoProvider":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListAllSsoProvider.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listAllSsoProvider(decoded)));
    case "v1ListAvailableRestoreVersions":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1ListAvailableRestoreVersions.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.listAvailableRestoreVersions(decoded)));
    case "v1ListJitAccess":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListJitAccess.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listJitAccess(decoded)));
    case "v1ListMigrationHistory":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListMigrationHistory.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listMigrationHistory(decoded)));
    case "v1ListOrganizationMembers":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListOrganizationMembers.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listOrganizationMembers(decoded)));
    case "v1ListProjectAddons":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ListProjectAddons.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.listProjectAddons(decoded)));
    case "v1ListProjectTpaIntegrations":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1ListProjectTpaIntegrations.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.listProjectTpaIntegrations(decoded)));
    case "v1MergeABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1MergeABranch.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.mergeABranch(decoded)));
    case "v1ModifyDatabaseDisk":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ModifyDatabaseDisk.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.modifyDatabaseDisk(decoded)));
    case "v1OauthAuthorizeProjectClaim":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1OauthAuthorizeProjectClaim.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.oauthAuthorizeProjectClaim(decoded)));
    case "v1PatchAMigration":
      return Schema.decodeUnknownEffect(operationDefinitions.v1PatchAMigration.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.patchAMigration(decoded)));
    case "v1PatchNetworkRestrictions":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1PatchNetworkRestrictions.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.patchNetworkRestrictions(decoded)));
    case "v1PauseAProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1PauseAProject.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.pauseAProject(decoded)));
    case "v1PushABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1PushABranch.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.pushABranch(decoded)),
      );
    case "v1ReadOnlyQuery":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ReadOnlyQuery.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.readOnlyQuery(decoded)));
    case "v1RemoveAReadReplica":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RemoveAReadReplica.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.removeAReadReplica(decoded)));
    case "v1RemoveProjectAddon":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RemoveProjectAddon.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.removeProjectAddon(decoded)));
    case "v1RemoveProjectSigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RemoveProjectSigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.removeProjectSigningKey(decoded)));
    case "v1ResetABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ResetABranch.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.resetABranch(decoded)));
    case "v1RestoreABranch":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RestoreABranch.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.restoreABranch(decoded)));
    case "v1RestoreAProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RestoreAProject.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.restoreAProject(decoded)));
    case "v1RestorePitrBackup":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RestorePitrBackup.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.restorePitrBackup(decoded)));
    case "v1RevokeToken":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RevokeToken.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.revokeToken(decoded)),
      );
    case "v1RollbackMigrations":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RollbackMigrations.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.rollbackMigrations(decoded)));
    case "v1RunAQuery":
      return Schema.decodeUnknownEffect(operationDefinitions.v1RunAQuery.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.runAQuery(decoded)),
      );
    case "v1SetupAReadReplica":
      return Schema.decodeUnknownEffect(operationDefinitions.v1SetupAReadReplica.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.setupAReadReplica(decoded)));
    case "v1ShutdownRealtime":
      return Schema.decodeUnknownEffect(operationDefinitions.v1ShutdownRealtime.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.shutdownRealtime(decoded)));
    case "v1Undo":
      return Schema.decodeUnknownEffect(operationDefinitions.v1Undo.inputSchema)(input).pipe(
        Effect.flatMap((decoded) => api.v1.undo(decoded)),
      );
    case "v1UpdateABranchConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateABranchConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateABranchConfig(decoded)));
    case "v1UpdateAFunction":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateAFunction.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateAFunction(decoded)));
    case "v1UpdateAProject":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateAProject.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateAProject(decoded)));
    case "v1UpdateASsoProvider":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateASsoProvider.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateASsoProvider(decoded)));
    case "v1UpdateActionRunStatus":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateActionRunStatus.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateActionRunStatus(decoded)));
    case "v1UpdateAuthServiceConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateAuthServiceConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateAuthServiceConfig(decoded)));
    case "v1UpdateDatabasePassword":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateDatabasePassword.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateDatabasePassword(decoded)));
    case "v1UpdateHostnameConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateHostnameConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateHostnameConfig(decoded)));
    case "v1UpdateJitAccess":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateJitAccess.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateJitAccess(decoded)));
    case "v1UpdateJitAccessConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateJitAccessConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateJitAccessConfig(decoded)));
    case "v1UpdateNetworkRestrictions":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1UpdateNetworkRestrictions.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.updateNetworkRestrictions(decoded)));
    case "v1UpdatePgsodiumConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdatePgsodiumConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updatePgsodiumConfig(decoded)));
    case "v1UpdatePoolerConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdatePoolerConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updatePoolerConfig(decoded)));
    case "v1UpdatePostgresConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdatePostgresConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updatePostgresConfig(decoded)));
    case "v1UpdatePostgrestServiceConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1UpdatePostgrestServiceConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.updatePostgrestServiceConfig(decoded)));
    case "v1UpdateProjectApiKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateProjectApiKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateProjectApiKey(decoded)));
    case "v1UpdateProjectLegacyApiKeys":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1UpdateProjectLegacyApiKeys.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.updateProjectLegacyApiKeys(decoded)));
    case "v1UpdateProjectSigningKey":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateProjectSigningKey.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateProjectSigningKey(decoded)));
    case "v1UpdateRealtimeConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateRealtimeConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateRealtimeConfig(decoded)));
    case "v1UpdateSslEnforcementConfig":
      return Schema.decodeUnknownEffect(
        operationDefinitions.v1UpdateSslEnforcementConfig.inputSchema,
      )(input).pipe(Effect.flatMap((decoded) => api.v1.updateSslEnforcementConfig(decoded)));
    case "v1UpdateStorageConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpdateStorageConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.updateStorageConfig(decoded)));
    case "v1UpgradePostgresVersion":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpgradePostgresVersion.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.upgradePostgresVersion(decoded)));
    case "v1UpsertAMigration":
      return Schema.decodeUnknownEffect(operationDefinitions.v1UpsertAMigration.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.upsertAMigration(decoded)));
    case "v1VerifyDnsConfig":
      return Schema.decodeUnknownEffect(operationDefinitions.v1VerifyDnsConfig.inputSchema)(
        input,
      ).pipe(Effect.flatMap((decoded) => api.v1.verifyDnsConfig(decoded)));
  }
}
