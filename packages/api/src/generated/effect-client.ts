import { Effect } from "effect";

import type { SupabaseApiError, SupabaseApiRequestOptions } from "../internal/client.ts";
import { SupabaseApiClient } from "../internal/client.ts";
import { operationDefinitions } from "./contracts.ts";

export const versionedEffectOperations = {
  v1: {
    acceptInviteExternalJitAccess: (
      input: typeof operationDefinitions.v1AcceptInviteExternalJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1AcceptInviteExternalJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1AcceptInviteExternalJitAccess">(
          operationDefinitions.v1AcceptInviteExternalJitAccess,
          input,
          options,
        );
      }),
    activateCustomHostname: (
      input: typeof operationDefinitions.v1ActivateCustomHostname.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    activateVanitySubdomainConfig: (
      input: typeof operationDefinitions.v1ActivateVanitySubdomainConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    applyAMigration: (
      input: typeof operationDefinitions.v1ApplyAMigration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    applyProjectAddon: (
      input: typeof operationDefinitions.v1ApplyProjectAddon.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    authorizeJitAccess: (
      input: typeof operationDefinitions.v1AuthorizeJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    authorizeUser: (
      input: typeof operationDefinitions.v1AuthorizeUser.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    bulkCreateSecrets: (
      input: typeof operationDefinitions.v1BulkCreateSecrets.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    bulkDeleteSecrets: (
      input: typeof operationDefinitions.v1BulkDeleteSecrets.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    bulkUpdateFunctions: (
      input: typeof operationDefinitions.v1BulkUpdateFunctions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    cancelAProjectRestoration: (
      input: typeof operationDefinitions.v1CancelAProjectRestoration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    checkVanitySubdomainAvailability: (
      input: typeof operationDefinitions.v1CheckVanitySubdomainAvailability.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    claimProjectForOrganization: (
      input: typeof operationDefinitions.v1ClaimProjectForOrganization.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    countActionRuns: (
      input: typeof operationDefinitions.v1CountActionRuns.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createABranch: (
      input: typeof operationDefinitions.v1CreateABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createAFunction: (
      input: typeof operationDefinitions.v1CreateAFunction.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createAProject: (
      input: typeof operationDefinitions.v1CreateAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createASsoProvider: (
      input: typeof operationDefinitions.v1CreateASsoProvider.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createAnOrganization: (
      input: typeof operationDefinitions.v1CreateAnOrganization.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createLegacySigningKey: (
      input: typeof operationDefinitions.v1CreateLegacySigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createLoginRole: (
      input: typeof operationDefinitions.v1CreateLoginRole.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createProjectApiKey: (
      input: typeof operationDefinitions.v1CreateProjectApiKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createProjectClaimToken: (
      input: typeof operationDefinitions.v1CreateProjectClaimToken.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createProjectSigningKey: (
      input: typeof operationDefinitions.v1CreateProjectSigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createProjectTpaIntegration: (
      input: typeof operationDefinitions.v1CreateProjectTpaIntegration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    createRestorePoint: (
      input: typeof operationDefinitions.v1CreateRestorePoint.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deactivateVanitySubdomainConfig: (
      input: typeof operationDefinitions.v1DeactivateVanitySubdomainConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteHostnameConfig: (
      input: typeof operationDefinitions.v1DeleteHostnameConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteABranch: (
      input: typeof operationDefinitions.v1DeleteABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteAFunction: (
      input: typeof operationDefinitions.v1DeleteAFunction.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteAProject: (
      input: typeof operationDefinitions.v1DeleteAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteASsoProvider: (
      input: typeof operationDefinitions.v1DeleteASsoProvider.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteInviteExternalJitAccess: (
      input: typeof operationDefinitions.v1DeleteInviteExternalJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1DeleteInviteExternalJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1DeleteInviteExternalJitAccess">(
          operationDefinitions.v1DeleteInviteExternalJitAccess,
          input,
          options,
        );
      }),
    deleteJitAccess: (
      input: typeof operationDefinitions.v1DeleteJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteLoginRoles: (
      input: typeof operationDefinitions.v1DeleteLoginRoles.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteNetworkBans: (
      input: typeof operationDefinitions.v1DeleteNetworkBans.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteProjectApiKey: (
      input: typeof operationDefinitions.v1DeleteProjectApiKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteProjectClaimToken: (
      input: typeof operationDefinitions.v1DeleteProjectClaimToken.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deleteProjectTpaIntegration: (
      input: typeof operationDefinitions.v1DeleteProjectTpaIntegration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    deployAFunction: (
      input: typeof operationDefinitions.v1DeployAFunction.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    diffABranch: (
      input: typeof operationDefinitions.v1DiffABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1DiffABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1DiffABranch">(
          operationDefinitions.v1DiffABranch,
          input,
          options,
        );
      }),
    disablePreviewBranching: (
      input: typeof operationDefinitions.v1DisablePreviewBranching.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    disableReadonlyModeTemporarily: (
      input: typeof operationDefinitions.v1DisableReadonlyModeTemporarily.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    enableDatabaseWebhook: (
      input: typeof operationDefinitions.v1EnableDatabaseWebhook.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    exchangeOauthToken: (
      input: typeof operationDefinitions.v1ExchangeOauthToken.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    generateTypescriptTypes: (
      input: typeof operationDefinitions.v1GenerateTypescriptTypes.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getABranch: (
      input: typeof operationDefinitions.v1GetABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetABranch">(
          operationDefinitions.v1GetABranch,
          input,
          options,
        );
      }),
    getABranchConfig: (
      input: typeof operationDefinitions.v1GetABranchConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAFunction: (
      input: typeof operationDefinitions.v1GetAFunction.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetAFunction.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetAFunction">(
          operationDefinitions.v1GetAFunction,
          input,
          options,
        );
      }),
    getAFunctionBody: (
      input: typeof operationDefinitions.v1GetAFunctionBody.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAMigration: (
      input: typeof operationDefinitions.v1GetAMigration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getASnippet: (
      input: typeof operationDefinitions.v1GetASnippet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetASnippet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetASnippet">(
          operationDefinitions.v1GetASnippet,
          input,
          options,
        );
      }),
    getASsoProvider: (
      input: typeof operationDefinitions.v1GetASsoProvider.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getActionRun: (
      input: typeof operationDefinitions.v1GetActionRun.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetActionRun.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetActionRun">(
          operationDefinitions.v1GetActionRun,
          input,
          options,
        );
      }),
    getActionRunLogs: (
      input: typeof operationDefinitions.v1GetActionRunLogs.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAllProjectsForOrganization: (
      input: typeof operationDefinitions.v1GetAllProjectsForOrganization.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAnOrganization: (
      input: typeof operationDefinitions.v1GetAnOrganization.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAuthServiceConfig: (
      input: typeof operationDefinitions.v1GetAuthServiceConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getAvailableRegions: (
      input: typeof operationDefinitions.v1GetAvailableRegions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getBackupSchedule: (
      input: typeof operationDefinitions.v1GetBackupSchedule.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetBackupSchedule.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetBackupSchedule">(
          operationDefinitions.v1GetBackupSchedule,
          input,
          options,
        );
      }),
    getDatabaseDisk: (
      input: typeof operationDefinitions.v1GetDatabaseDisk.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getDatabaseMetadata: (
      input: typeof operationDefinitions.v1GetDatabaseMetadata.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getDatabaseOpenapi: (
      input: typeof operationDefinitions.v1GetDatabaseOpenapi.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getDiskUtilization: (
      input: typeof operationDefinitions.v1GetDiskUtilization.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getHostnameConfig: (
      input: typeof operationDefinitions.v1GetHostnameConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getJitAccess: (
      input: typeof operationDefinitions.v1GetJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetJitAccess">(
          operationDefinitions.v1GetJitAccess,
          input,
          options,
        );
      }),
    getJitAccessConfig: (
      input: typeof operationDefinitions.v1GetJitAccessConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getLegacySigningKey: (
      input: typeof operationDefinitions.v1GetLegacySigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getNetworkRestrictions: (
      input: typeof operationDefinitions.v1GetNetworkRestrictions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getOrganizationEntitlements: (
      input: typeof operationDefinitions.v1GetOrganizationEntitlements.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getOrganizationProjectClaim: (
      input: typeof operationDefinitions.v1GetOrganizationProjectClaim.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPerformanceAdvisors: (
      input: typeof operationDefinitions.v1GetPerformanceAdvisors.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPgsodiumConfig: (
      input: typeof operationDefinitions.v1GetPgsodiumConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPoolerConfig: (
      input: typeof operationDefinitions.v1GetPoolerConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPostgresConfig: (
      input: typeof operationDefinitions.v1GetPostgresConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPostgresUpgradeEligibility: (
      input: typeof operationDefinitions.v1GetPostgresUpgradeEligibility.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPostgresUpgradeStatus: (
      input: typeof operationDefinitions.v1GetPostgresUpgradeStatus.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getPostgrestServiceConfig: (
      input: typeof operationDefinitions.v1GetPostgrestServiceConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProfile: (
      _input: Record<string, never> = {},
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetProfile.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProfile">(
          operationDefinitions.v1GetProfile,
          {},
          options,
        );
      }),
    getProject: (
      input: typeof operationDefinitions.v1GetProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProject">(
          operationDefinitions.v1GetProject,
          input,
          options,
        );
      }),
    getProjectApiKey: (
      input: typeof operationDefinitions.v1GetProjectApiKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectApiKeys: (
      input: typeof operationDefinitions.v1GetProjectApiKeys.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectClaimToken: (
      input: typeof operationDefinitions.v1GetProjectClaimToken.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectDiskAutoscaleConfig: (
      input: typeof operationDefinitions.v1GetProjectDiskAutoscaleConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectFunctionCombinedStats: (
      input: typeof operationDefinitions.v1GetProjectFunctionCombinedStats.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectLegacyApiKeys: (
      input: typeof operationDefinitions.v1GetProjectLegacyApiKeys.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectLogs: (
      input: typeof operationDefinitions.v1GetProjectLogs.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectLogsAll: (
      input: typeof operationDefinitions.v1GetProjectLogsAll.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1GetProjectLogsAll.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1GetProjectLogsAll">(
          operationDefinitions.v1GetProjectLogsAll,
          input,
          options,
        );
      }),
    getProjectPgbouncerConfig: (
      input: typeof operationDefinitions.v1GetProjectPgbouncerConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectSigningKey: (
      input: typeof operationDefinitions.v1GetProjectSigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectSigningKeys: (
      input: typeof operationDefinitions.v1GetProjectSigningKeys.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectTpaIntegration: (
      input: typeof operationDefinitions.v1GetProjectTpaIntegration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectUsageApiCount: (
      input: typeof operationDefinitions.v1GetProjectUsageApiCount.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getProjectUsageRequestCount: (
      input: typeof operationDefinitions.v1GetProjectUsageRequestCount.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getReadonlyModeStatus: (
      input: typeof operationDefinitions.v1GetReadonlyModeStatus.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getRealtimeConfig: (
      input: typeof operationDefinitions.v1GetRealtimeConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getRestorePoint: (
      input: typeof operationDefinitions.v1GetRestorePoint.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getSecurityAdvisors: (
      input: typeof operationDefinitions.v1GetSecurityAdvisors.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getServicesHealth: (
      input: typeof operationDefinitions.v1GetServicesHealth.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getSslEnforcementConfig: (
      input: typeof operationDefinitions.v1GetSslEnforcementConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getStorageConfig: (
      input: typeof operationDefinitions.v1GetStorageConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    getVanitySubdomainConfig: (
      input: typeof operationDefinitions.v1GetVanitySubdomainConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    inviteExternalJitAccess: (
      input: typeof operationDefinitions.v1InviteExternalJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1InviteExternalJitAccess.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1InviteExternalJitAccess">(
          operationDefinitions.v1InviteExternalJitAccess,
          input,
          options,
        );
      }),
    listActionRuns: (
      input: typeof operationDefinitions.v1ListActionRuns.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllBackups: (
      input: typeof operationDefinitions.v1ListAllBackups.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllBranches: (
      input: typeof operationDefinitions.v1ListAllBranches.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllBuckets: (
      input: typeof operationDefinitions.v1ListAllBuckets.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllFunctions: (
      input: typeof operationDefinitions.v1ListAllFunctions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllNetworkBans: (
      input: typeof operationDefinitions.v1ListAllNetworkBans.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllNetworkBansEnriched: (
      input: typeof operationDefinitions.v1ListAllNetworkBansEnriched.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllOrganizations: (
      _input: Record<string, never> = {},
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListAllOrganizations.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllOrganizations">(
          operationDefinitions.v1ListAllOrganizations,
          {},
          options,
        );
      }),
    listAllProjects: (
      _input: Record<string, never> = {},
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1ListAllProjects.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ListAllProjects">(
          operationDefinitions.v1ListAllProjects,
          {},
          options,
        );
      }),
    listAllSecrets: (
      input: typeof operationDefinitions.v1ListAllSecrets.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllSnippets: (
      input: typeof operationDefinitions.v1ListAllSnippets.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAllSsoProvider: (
      input: typeof operationDefinitions.v1ListAllSsoProvider.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listAvailableRestoreVersions: (
      input: typeof operationDefinitions.v1ListAvailableRestoreVersions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listJitAccess: (
      input: typeof operationDefinitions.v1ListJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listMigrationHistory: (
      input: typeof operationDefinitions.v1ListMigrationHistory.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listOrganizationMembers: (
      input: typeof operationDefinitions.v1ListOrganizationMembers.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listProjectAddons: (
      input: typeof operationDefinitions.v1ListProjectAddons.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    listProjectTpaIntegrations: (
      input: typeof operationDefinitions.v1ListProjectTpaIntegrations.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    mergeABranch: (
      input: typeof operationDefinitions.v1MergeABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1MergeABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1MergeABranch">(
          operationDefinitions.v1MergeABranch,
          input,
          options,
        );
      }),
    modifyDatabaseDisk: (
      input: typeof operationDefinitions.v1ModifyDatabaseDisk.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    oauthAuthorizeProjectClaim: (
      input: typeof operationDefinitions.v1OauthAuthorizeProjectClaim.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    patchAMigration: (
      input: typeof operationDefinitions.v1PatchAMigration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    patchNetworkRestrictions: (
      input: typeof operationDefinitions.v1PatchNetworkRestrictions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    pauseAProject: (
      input: typeof operationDefinitions.v1PauseAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    pushABranch: (
      input: typeof operationDefinitions.v1PushABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1PushABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1PushABranch">(
          operationDefinitions.v1PushABranch,
          input,
          options,
        );
      }),
    readOnlyQuery: (
      input: typeof operationDefinitions.v1ReadOnlyQuery.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    removeAReadReplica: (
      input: typeof operationDefinitions.v1RemoveAReadReplica.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    removeProjectAddon: (
      input: typeof operationDefinitions.v1RemoveProjectAddon.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    removeProjectSigningKey: (
      input: typeof operationDefinitions.v1RemoveProjectSigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    resetABranch: (
      input: typeof operationDefinitions.v1ResetABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1ResetABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ResetABranch">(
          operationDefinitions.v1ResetABranch,
          input,
          options,
        );
      }),
    restartAProject: (
      input: typeof operationDefinitions.v1RestartAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1RestartAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RestartAProject">(
          operationDefinitions.v1RestartAProject,
          input,
          options,
        );
      }),
    restoreABranch: (
      input: typeof operationDefinitions.v1RestoreABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    restoreAProject: (
      input: typeof operationDefinitions.v1RestoreAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    restorePhysicalBackup: (
      input: typeof operationDefinitions.v1RestorePhysicalBackup.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1RestorePhysicalBackup.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RestorePhysicalBackup">(
          operationDefinitions.v1RestorePhysicalBackup,
          input,
          options,
        );
      }),
    restorePitrBackup: (
      input: typeof operationDefinitions.v1RestorePitrBackup.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    revokeToken: (
      input: typeof operationDefinitions.v1RevokeToken.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1RevokeToken.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RevokeToken">(
          operationDefinitions.v1RevokeToken,
          input,
          options,
        );
      }),
    rollbackMigrations: (
      input: typeof operationDefinitions.v1RollbackMigrations.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    runAQuery: (
      input: typeof operationDefinitions.v1RunAQuery.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1RunAQuery.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1RunAQuery">(
          operationDefinitions.v1RunAQuery,
          input,
          options,
        );
      }),
    scrapeProjectMetrics: (
      input: typeof operationDefinitions.v1ScrapeProjectMetrics.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1ScrapeProjectMetrics.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1ScrapeProjectMetrics">(
          operationDefinitions.v1ScrapeProjectMetrics,
          input,
          options,
        );
      }),
    setupAReadReplica: (
      input: typeof operationDefinitions.v1SetupAReadReplica.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    shutdownRealtime: (
      input: typeof operationDefinitions.v1ShutdownRealtime.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    undo: (
      input: typeof operationDefinitions.v1Undo.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1Undo.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1Undo">(operationDefinitions.v1Undo, input, options);
      }),
    updateABranchConfig: (
      input: typeof operationDefinitions.v1UpdateABranchConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateAFunction: (
      input: typeof operationDefinitions.v1UpdateAFunction.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateAProject: (
      input: typeof operationDefinitions.v1UpdateAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateASsoProvider: (
      input: typeof operationDefinitions.v1UpdateASsoProvider.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateActionRunStatus: (
      input: typeof operationDefinitions.v1UpdateActionRunStatus.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateAuthServiceConfig: (
      input: typeof operationDefinitions.v1UpdateAuthServiceConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateBackupSchedule: (
      input: typeof operationDefinitions.v1UpdateBackupSchedule.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v1UpdateBackupSchedule.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v1UpdateBackupSchedule">(
          operationDefinitions.v1UpdateBackupSchedule,
          input,
          options,
        );
      }),
    updateDatabasePassword: (
      input: typeof operationDefinitions.v1UpdateDatabasePassword.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateHostnameConfig: (
      input: typeof operationDefinitions.v1UpdateHostnameConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateJitAccess: (
      input: typeof operationDefinitions.v1UpdateJitAccess.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateJitAccessConfig: (
      input: typeof operationDefinitions.v1UpdateJitAccessConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateNetworkRestrictions: (
      input: typeof operationDefinitions.v1UpdateNetworkRestrictions.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updatePgsodiumConfig: (
      input: typeof operationDefinitions.v1UpdatePgsodiumConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updatePoolerConfig: (
      input: typeof operationDefinitions.v1UpdatePoolerConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updatePostgresConfig: (
      input: typeof operationDefinitions.v1UpdatePostgresConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updatePostgrestServiceConfig: (
      input: typeof operationDefinitions.v1UpdatePostgrestServiceConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateProjectApiKey: (
      input: typeof operationDefinitions.v1UpdateProjectApiKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateProjectLegacyApiKeys: (
      input: typeof operationDefinitions.v1UpdateProjectLegacyApiKeys.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateProjectSigningKey: (
      input: typeof operationDefinitions.v1UpdateProjectSigningKey.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateRealtimeConfig: (
      input: typeof operationDefinitions.v1UpdateRealtimeConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateSslEnforcementConfig: (
      input: typeof operationDefinitions.v1UpdateSslEnforcementConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    updateStorageConfig: (
      input: typeof operationDefinitions.v1UpdateStorageConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    upgradePostgresVersion: (
      input: typeof operationDefinitions.v1UpgradePostgresVersion.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    upsertAMigration: (
      input: typeof operationDefinitions.v1UpsertAMigration.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
    verifyDnsConfig: (
      input: typeof operationDefinitions.v1VerifyDnsConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
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
          options,
        );
      }),
  },
  v2: {
    assignOrganizationMemberRole: (
      input: typeof operationDefinitions.v2AssignOrganizationMemberRole.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2AssignOrganizationMemberRole.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2AssignOrganizationMemberRole">(
          operationDefinitions.v2AssignOrganizationMemberRole,
          input,
          options,
        );
      }),
    createABranch: (
      input: typeof operationDefinitions.v2CreateABranch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreateABranch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreateABranch">(
          operationDefinitions.v2CreateABranch,
          input,
          options,
        );
      }),
    createComputeInstanceUpload: (
      input: typeof operationDefinitions.v2CreateComputeInstanceUpload.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreateComputeInstanceUpload.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreateComputeInstanceUpload">(
          operationDefinitions.v2CreateComputeInstanceUpload,
          input,
          options,
        );
      }),
    createLogDrain: (
      input: typeof operationDefinitions.v2CreateLogDrain.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreateLogDrain.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreateLogDrain">(
          operationDefinitions.v2CreateLogDrain,
          input,
          options,
        );
      }),
    createNotebook: (
      input: typeof operationDefinitions.v2CreateNotebook.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreateNotebook.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreateNotebook">(
          operationDefinitions.v2CreateNotebook,
          input,
          options,
        );
      }),
    createOrganizationInvitations: (
      input: typeof operationDefinitions.v2CreateOrganizationInvitations.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreateOrganizationInvitations.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreateOrganizationInvitations">(
          operationDefinitions.v2CreateOrganizationInvitations,
          input,
          options,
        );
      }),
    createPrivateLinkAssociation: (
      input: typeof operationDefinitions.v2CreatePrivateLinkAssociation.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2CreatePrivateLinkAssociation.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2CreatePrivateLinkAssociation">(
          operationDefinitions.v2CreatePrivateLinkAssociation,
          input,
          options,
        );
      }),
    deleteAComputeInstance: (
      input: typeof operationDefinitions.v2DeleteAComputeInstance.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeleteAComputeInstance.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeleteAComputeInstance">(
          operationDefinitions.v2DeleteAComputeInstance,
          input,
          options,
        );
      }),
    deleteLogDrain: (
      input: typeof operationDefinitions.v2DeleteLogDrain.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeleteLogDrain.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeleteLogDrain">(
          operationDefinitions.v2DeleteLogDrain,
          input,
          options,
        );
      }),
    deleteNotebook: (
      input: typeof operationDefinitions.v2DeleteNotebook.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeleteNotebook.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeleteNotebook">(
          operationDefinitions.v2DeleteNotebook,
          input,
          options,
        );
      }),
    deleteOrganizationInvitations: (
      input: typeof operationDefinitions.v2DeleteOrganizationInvitations.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeleteOrganizationInvitations.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeleteOrganizationInvitations">(
          operationDefinitions.v2DeleteOrganizationInvitations,
          input,
          options,
        );
      }),
    deletePrivateLinkAssociation: (
      input: typeof operationDefinitions.v2DeletePrivateLinkAssociation.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeletePrivateLinkAssociation.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeletePrivateLinkAssociation">(
          operationDefinitions.v2DeletePrivateLinkAssociation,
          input,
          options,
        );
      }),
    deletePrivateLinkAssociationForDatabase: (
      input: typeof operationDefinitions.v2DeletePrivateLinkAssociationForDatabase.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeletePrivateLinkAssociationForDatabase.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeletePrivateLinkAssociationForDatabase">(
          operationDefinitions.v2DeletePrivateLinkAssociationForDatabase,
          input,
          options,
        );
      }),
    deployAComputeInstance: (
      input: typeof operationDefinitions.v2DeployAComputeInstance.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DeployAComputeInstance.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DeployAComputeInstance">(
          operationDefinitions.v2DeployAComputeInstance,
          input,
          options,
        );
      }),
    downloadProjectBackup: (
      input: typeof operationDefinitions.v2DownloadProjectBackup.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2DownloadProjectBackup.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2DownloadProjectBackup">(
          operationDefinitions.v2DownloadProjectBackup,
          input,
          options,
        );
      }),
    getAComputeInstance: (
      input: typeof operationDefinitions.v2GetAComputeInstance.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2GetAComputeInstance.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2GetAComputeInstance">(
          operationDefinitions.v2GetAComputeInstance,
          input,
          options,
        );
      }),
    getNotebook: (
      input: typeof operationDefinitions.v2GetNotebook.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2GetNotebook.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2GetNotebook">(
          operationDefinitions.v2GetNotebook,
          input,
          options,
        );
      }),
    getProjectConfig: (
      input: typeof operationDefinitions.v2GetProjectConfig.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2GetProjectConfig.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2GetProjectConfig">(
          operationDefinitions.v2GetProjectConfig,
          input,
          options,
        );
      }),
    listAllComputeInstances: (
      input: typeof operationDefinitions.v2ListAllComputeInstances.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListAllComputeInstances.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListAllComputeInstances">(
          operationDefinitions.v2ListAllComputeInstances,
          input,
          options,
        );
      }),
    listLogDrains: (
      input: typeof operationDefinitions.v2ListLogDrains.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListLogDrains.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListLogDrains">(
          operationDefinitions.v2ListLogDrains,
          input,
          options,
        );
      }),
    listNotebooks: (
      input: typeof operationDefinitions.v2ListNotebooks.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListNotebooks.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListNotebooks">(
          operationDefinitions.v2ListNotebooks,
          input,
          options,
        );
      }),
    listOrganizationGithubConnections: (
      input: typeof operationDefinitions.v2ListOrganizationGithubConnections.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListOrganizationGithubConnections.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListOrganizationGithubConnections">(
          operationDefinitions.v2ListOrganizationGithubConnections,
          input,
          options,
        );
      }),
    listOrganizationMaintenanceWindows: (
      input: typeof operationDefinitions.v2ListOrganizationMaintenanceWindows.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListOrganizationMaintenanceWindows.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListOrganizationMaintenanceWindows">(
          operationDefinitions.v2ListOrganizationMaintenanceWindows,
          input,
          options,
        );
      }),
    listOrganizationMembers: (
      input: typeof operationDefinitions.v2ListOrganizationMembers.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListOrganizationMembers.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListOrganizationMembers">(
          operationDefinitions.v2ListOrganizationMembers,
          input,
          options,
        );
      }),
    listOrganizationProjects: (
      input: typeof operationDefinitions.v2ListOrganizationProjects.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListOrganizationProjects.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListOrganizationProjects">(
          operationDefinitions.v2ListOrganizationProjects,
          input,
          options,
        );
      }),
    listOrganizationRoles: (
      input: typeof operationDefinitions.v2ListOrganizationRoles.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListOrganizationRoles.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListOrganizationRoles">(
          operationDefinitions.v2ListOrganizationRoles,
          input,
          options,
        );
      }),
    listPrivateLinkAssociations: (
      input: typeof operationDefinitions.v2ListPrivateLinkAssociations.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ListPrivateLinkAssociations.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ListPrivateLinkAssociations">(
          operationDefinitions.v2ListPrivateLinkAssociations,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksDeliveriesIdGet: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksDeliveriesIdGet">(
          operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdGet,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksDeliveriesIdRetryPost: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdRetryPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdRetryPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksDeliveriesIdRetryPost">(
          operationDefinitions.v2OrganizationsSlugWebhooksDeliveriesIdRetryPost,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsDelete: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsDelete.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsDelete.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsDelete">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsDelete,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsGet: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsGet">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsGet,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsIdDelete: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDelete.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDelete.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsIdDelete">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDelete,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsIdDeliveriesGet: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDeliveriesGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDeliveriesGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsIdDeliveriesGet">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdDeliveriesGet,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsIdGet: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsIdGet">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdGet,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsIdPatch: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdPatch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdPatch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsIdPatch">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdPatch,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsIdTestPost: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdTestPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdTestPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsIdTestPost">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsIdTestPost,
          input,
          options,
        );
      }),
    organizationsSlugWebhooksEndpointsPost: (
      input: typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2OrganizationsSlugWebhooksEndpointsPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2OrganizationsSlugWebhooksEndpointsPost">(
          operationDefinitions.v2OrganizationsSlugWebhooksEndpointsPost,
          input,
          options,
        );
      }),
    previewAProjectTransfer: (
      input: typeof operationDefinitions.v2PreviewAProjectTransfer.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2PreviewAProjectTransfer.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2PreviewAProjectTransfer">(
          operationDefinitions.v2PreviewAProjectTransfer,
          input,
          options,
        );
      }),
    projectsRefWebhooksDeliveriesIdGet: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksDeliveriesIdGet">(
          operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdGet,
          input,
          options,
        );
      }),
    projectsRefWebhooksDeliveriesIdRetryPost: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdRetryPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdRetryPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksDeliveriesIdRetryPost">(
          operationDefinitions.v2ProjectsRefWebhooksDeliveriesIdRetryPost,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsDelete: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsDelete.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsDelete.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsDelete">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsDelete,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsGet: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsGet">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsGet,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsIdDelete: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDelete.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDelete.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsIdDelete">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDelete,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsIdDeliveriesGet: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDeliveriesGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDeliveriesGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsIdDeliveriesGet">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsIdDeliveriesGet,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsIdGet: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdGet.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdGet.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsIdGet">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsIdGet,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsIdPatch: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdPatch.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdPatch.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsIdPatch">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsIdPatch,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsIdTestPost: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdTestPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsIdTestPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsIdTestPost">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsIdTestPost,
          input,
          options,
        );
      }),
    projectsRefWebhooksEndpointsPost: (
      input: typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsPost.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2ProjectsRefWebhooksEndpointsPost.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2ProjectsRefWebhooksEndpointsPost">(
          operationDefinitions.v2ProjectsRefWebhooksEndpointsPost,
          input,
          options,
        );
      }),
    removeOrganizationMembers: (
      input: typeof operationDefinitions.v2RemoveOrganizationMembers.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2RemoveOrganizationMembers.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2RemoveOrganizationMembers">(
          operationDefinitions.v2RemoveOrganizationMembers,
          input,
          options,
        );
      }),
    runProjectAdvisors: (
      input: typeof operationDefinitions.v2RunProjectAdvisors.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2RunProjectAdvisors.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2RunProjectAdvisors">(
          operationDefinitions.v2RunProjectAdvisors,
          input,
          options,
        );
      }),
    transferAProject: (
      input: typeof operationDefinitions.v2TransferAProject.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2TransferAProject.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2TransferAProject">(
          operationDefinitions.v2TransferAProject,
          input,
          options,
        );
      }),
    updateLogDrain: (
      input: typeof operationDefinitions.v2UpdateLogDrain.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2UpdateLogDrain.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2UpdateLogDrain">(
          operationDefinitions.v2UpdateLogDrain,
          input,
          options,
        );
      }),
    updateNotebook: (
      input: typeof operationDefinitions.v2UpdateNotebook.inputSchema.Type,
      options?: SupabaseApiRequestOptions,
    ): Effect.Effect<
      typeof operationDefinitions.v2UpdateNotebook.outputSchema.Type,
      SupabaseApiError,
      SupabaseApiClient
    > =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<"v2UpdateNotebook">(
          operationDefinitions.v2UpdateNotebook,
          input,
          options,
        );
      }),
  },
} as const;

export type GeneratedEffectOperations = typeof versionedEffectOperations;
