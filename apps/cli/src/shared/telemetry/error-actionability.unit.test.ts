import { describe, expect, test } from "vitest";
import {
  classifyCliErrorActionability,
  CliErrorActionabilityMetricDefinitions,
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
} from "./error-actionability.ts";

describe("CLI error actionability taxonomy", () => {
  test("defines the KPI classification values required for the Q2 baseline", () => {
    expect(Object.values(CliErrorKind)).toEqual([
      "user_actionable",
      "internal_bug",
      "external_service",
      "user_cancelled",
      "unknown",
    ]);

    expect(Object.values(CliErrorCategory)).toEqual(
      expect.arrayContaining([
        "auth",
        "missing_project_ref",
        "project_not_linked",
        "docker_not_running",
        "invalid_config",
        "db_connection",
        "migration_drift",
        "permission",
        "plan_limit",
        "invalid_input",
        "cancelled",
        "panic",
        "unknown",
        "impossible_state",
      ]),
    );

    expect(Object.values(CliSuggestionType)).toEqual(
      expect.arrayContaining([
        "login",
        "link_project",
        "start_docker",
        "provide_flags",
        "set_env_var",
        "repair_migration",
        "update_config",
        "upgrade_plan",
        "rerun_debug",
        "none",
      ]),
    );
  });

  test("documents queryable recovery and repeat definitions", () => {
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.id).toBe(
      "same_command_success_same_session",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.id).toBe(
      "same_command_same_error_same_session_before_success",
    );
    expect(CliErrorActionabilityMetricDefinitions.internalUnknownBugRate.id).toBe(
      "failed_commands_internal_bug_or_unknown",
    );
  });

  test("classifies auth errors without using raw messages", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "LegacyPlatformAuthRequiredError",
        message: "token abc123 for project ref xyz",
      }),
    ).toEqual({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyPlatformAuthRequiredError",
      has_suggestion: true,
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  test("classifies command-local auth wrappers as login remediations", () => {
    expect(
      classifyCliErrorActionability({ _tag: "LegacyDbAdvisorsNotLoggedInError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyDbAdvisorsNotLoggedInError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(
      classifyCliErrorActionability({ _tag: "LegacyDbQueryLoginRequiredError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyDbQueryLoginRequiredError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyStorageAuthTokenError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyStorageAuthTokenError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyLoginSaveTokenError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyLoginSaveTokenError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyLoginFailedError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyLoginFailedError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(classifyCliErrorActionability({ _tag: "LoginFailedError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LoginFailedError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyLoginDecryptError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyLoginDecryptError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  test("classifies login token failures as token remediations", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyLoginMissingTokenError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyLoginMissingTokenError",
      has_suggestion: true,
      suggestion_type: "set_env_var",
    });

    expect(classifyCliErrorActionability({ _tag: "NoTtyError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:NoTtyError",
      has_suggestion: true,
      suggestion_type: "set_env_var",
    });
  });

  test("splits SAML-disabled setup failures from entitlement gates", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacySsoAddSamlDisabledError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacySsoAddSamlDisabledError:saml_disabled",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacySsoListSamlDisabledError" })).toMatchObject(
      {
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: "tag:LegacySsoListSamlDisabledError:saml_disabled",
        suggestion_type: "update_config",
      },
    );

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoListSamlDisabledError",
        upgradeSuggested: true,
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoListSamlDisabledError:plan_limit",
      suggestion_type: "upgrade_plan",
    });
  });

  test("classifies plan-gated SSO failures as upgrade remediations", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoAddUnexpectedStatusError",
        status: 403,
        body: '{"error":"forbidden"}',
        upgradeSuggested: true,
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoAddUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoListUnexpectedStatusError",
        status: 403,
        body: '{"error":"forbidden"}',
        upgradeSuggested: true,
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoListUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoListUnexpectedStatusError",
        status: 403,
        body: '{"error":"forbidden"}',
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacySsoListUnexpectedStatusError:api_status",
      suggestion_type: "none",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoAddSamlDisabledError",
        upgradeSuggested: true,
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoAddSamlDisabledError:plan_limit",
      suggestion_type: "upgrade_plan",
    });
  });

  test("classifies SSO provider not-found wrappers as invalid input", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacySsoShowNotFoundError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacySsoShowNotFoundError",
      suggestion_type: "none",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacySsoUpdateNotFoundError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacySsoUpdateNotFoundError",
      suggestion_type: "none",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacySsoRemoveNotFoundError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacySsoRemoveNotFoundError",
      suggestion_type: "none",
    });

    for (const tag of ["LegacySsoUpdateNotFoundError", "LegacySsoRemoveNotFoundError"]) {
      expect(classifyCliErrorActionability({ _tag: tag, upgradeSuggested: true })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "plan_limit",
        error_fingerprint: `tag:${tag}:plan_limit`,
        suggestion_type: "upgrade_plan",
      });
    }
  });

  test("classifies SSO metadata and mapping input wrappers as input remediations", () => {
    for (const tag of [
      "LegacySsoAddMetadataFileError",
      "LegacySsoUpdateMetadataFileError",
      "LegacySsoAddAttributeMappingFileError",
      "LegacySsoUpdateAttributeMappingFileError",
      "LegacySsoMetadataUrlInvalidError",
      "LegacySsoMetadataUrlNonUtf8Error",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "provide_flags",
      });
    }
  });

  test("preserves branch empty-state remediation", () => {
    expect(
      classifyCliErrorActionability({ _tag: "LegacyBranchesBranchingDisabledError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacyBranchesBranchingDisabledError",
      has_suggestion: true,
      suggestion_type: "update_config",
      suggested_command: "supabase branches create",
    });
  });

  test("classifies gated status failures only when a safe plan signal is present", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "LegacyBranchesCreateUnexpectedStatusError",
        status: 402,
        body: "Branching limit reached. Upgrade your plan to create more preview branches.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacyBranchesCreateUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyBranchesUpdateUnexpectedStatusError",
        status: 403,
        body: "Upgrade your plan to enable persistent preview branches.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacyBranchesUpdateUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyVanitySubdomainsActivateUnexpectedStatusError",
        status: 402,
        body: "Vanity subdomain requires a paid plan. Open billing to upgrade.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacyVanitySubdomainsActivateUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoUpdateUnexpectedStatusError",
        status: 403,
        body: "SAML entitlement is not enabled for this organization.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoUpdateUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoAddUnexpectedStatusError",
        status: 402,
        body: "SAML entitlement requires an upgrade.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoAddUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacySsoListUnexpectedStatusError",
        status: 403,
        body: "SAML entitlement is not enabled for this organization.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "plan_limit",
      error_fingerprint: "tag:LegacySsoListUnexpectedStatusError:plan_limit",
      suggestion_type: "upgrade_plan",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyBranchesCreateUnexpectedStatusError",
        status: 400,
        body: "invalid branch name",
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacyBranchesCreateUnexpectedStatusError:api_status",
      suggestion_type: "none",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyBranchesUpdateUnexpectedStatusError",
        status: 503,
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacyBranchesUpdateUnexpectedStatusError:api_status",
      suggestion_type: "none",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyBackupListUnexpectedStatusError",
        status: 401,
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyBackupListUnexpectedStatusError:auth",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  test("classifies project link and project ref errors separately", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyProjectNotLinkedError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "project_not_linked",
      error_fingerprint: "tag:LegacyProjectNotLinkedError",
      suggestion_type: "link_project",
      suggested_command: "supabase link",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyProjectRefRequiredError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "missing_project_ref",
      error_fingerprint: "tag:LegacyProjectRefRequiredError",
      suggestion_type: "link_project",
    });

    expect(classifyCliErrorActionability({ _tag: "ProjectRefRequiredError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "missing_project_ref",
      error_fingerprint: "tag:ProjectRefRequiredError",
      suggestion_type: "link_project",
      suggested_command: "supabase link",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyProjectPausedError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyProjectPausedError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyProjectRefReadError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyProjectRefReadError",
      suggestion_type: "link_project",
      suggested_command: "supabase link",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyLinkMissingKeyError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "permission",
      error_fingerprint: "tag:LegacyLinkMissingKeyError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyUnlinkRefReadError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyUnlinkRefReadError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "NoAccessibleProjectsError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "permission",
      error_fingerprint: "tag:NoAccessibleProjectsError",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  test("classifies CLI input and non-interactive prompt failures as user-actionable", () => {
    expect(classifyCliErrorActionability({ _tag: "UnrecognizedOption" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      has_suggestion: false,
      suggestion_type: "none",
    });

    expect(classifyCliErrorActionability({ _tag: "NonInteractiveError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      has_suggestion: true,
      suggestion_type: "provide_flags",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyInvalidSecretPairError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacyInvalidSecretPairError",
      suggestion_type: "none",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacySsoInvalidUuidError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacySsoInvalidUuidError",
      suggestion_type: "none",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacySsoMutexFlagError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacySsoMutexFlagError",
      suggestion_type: "none",
    });

    for (const tag of [
      "LegacyBranchesEnvNotSupportedError",
      "LegacyFunctionsEnvNotSupportedError",
      "LegacyNetworkBansEnvNotSupportedError",
      "LegacyOrgsEnvNotSupportedError",
      "LegacyProjectsEnvNotSupportedError",
      "LegacySecretsEnvNotSupportedError",
      "LegacyServicesEnvNotSupportedError",
      "LegacySnippetsEnvNotSupportedError",
      "LegacySsoShowEnvNotSupportedError",
      "LegacySecretsEnvFileOpenError",
      "LegacySecretsEnvFileParseError",
      "LegacyNetworkBansInvalidIpError",
      "LegacyNetworkRestrictionsInvalidCidrError",
      "LegacyNetworkRestrictionsPrivateIpError",
      "LegacySnippetsInvalidIdError",
      "LegacyStorageObjectNotFoundError",
      "LegacyStorageFileError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: false,
        suggestion_type: "none",
      });
    }

    expect(classifyCliErrorActionability({ _tag: "LegacyTestDbRunError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyTestDbRunError",
      has_suggestion: false,
      suggestion_type: "none",
    });
  });

  test("preserves command-local input remediation tags", () => {
    for (const tag of [
      "InitExperimentalRequiredError",
      "InitAlreadyExistsError",
      "LegacyBranchesBranchNameEmptyError",
      "NoBranchNameError",
      "BranchAlreadyExistsError",
      "BranchNotFoundError",
      "PlatformInputError",
      "PlatformRouteNotFoundError",
      "PlatformMethodSelectionError",
      "InvalidServiceVersionOverrideError",
      "UnsupportedLogsOutputFormatError",
      "LegacyExperimentalRequiredError",
      "LegacyDbDumpRequiresDataOnlyError",
      "LegacyDbDumpMutuallyExclusiveFlagsError",
      "LegacyDbDumpOpenFileError",
      "LegacyDbDiffTargetFlagsError",
      "LegacyDbDiffEngineConflictError",
      "LegacyDbDiffExplicitFlagsError",
      "LegacyDbDiffUnknownTargetError",
      "LegacyMigrationLastZeroError",
      "LegacyMigrationLastTooLargeError",
      "LegacyDbQueryMutuallyExclusiveFlagsError",
      "LegacyDbQueryReadFileError",
      "LegacyDbQueryNoStdinSqlError",
      "LegacyDbQueryNoSqlError",
      "LegacyDbPullTargetFlagsError",
      "LegacyDbPullEngineConflictError",
      "LegacyDbLintMutuallyExclusiveFlagsError",
      "LegacyDbAdvisorsMutuallyExclusiveFlagsError",
      "LegacyDeclarativeNotEnabledError",
      "LegacyDeclarativeMutuallyExclusiveFlagsError",
      "LegacyDeclarativeNonInteractiveError",
      "LegacyDeclarativeInvalidDbUrlError",
      "LegacyPostgresConfigInvalidConfigValueError",
      "LegacyTestDbMutuallyExclusiveFlagsError",
      "LegacyInspectMutuallyExclusiveFlagsError",
      "LegacySslEnforcementMutuallyExclusiveFlagsError",
      "LegacySslEnforcementNoEnableDisableFlagError",
      "LegacyProjectsCreateMissingArgError",
      "LegacyProjectsCreateNameEmptyError",
      "LegacyProjectsDeleteRefRequiredError",
      "LegacyProjectsDeleteNotFoundError",
      "LegacySecretsNoArgumentsError",
      "LegacyInvalidGenTypesDurationError",
      "LegacyInvalidGenTypesDatabaseUrlError",
      "LegacyStorageInvalidUrlError",
      "LegacyStorageUrlParseError",
      "LegacyStorageMissingFlagError",
      "LegacyStorageMutuallyExclusiveFlagsError",
      "LegacyStorageUnsupportedOperationError",
      "LegacyStorageCopyBetweenBucketsError",
      "LegacyStorageUnsupportedMoveError",
      "LegacyStorageMissingPathError",
      "LegacyStorageMissingBucketError",
      "LegacySeedMutuallyExclusiveFlagsError",
      "InvalidFunctionDeploySlugError",
      "InvalidFunctionSlugError",
      "LegacyFunctionsNewInvalidSlugError",
      "LegacyFunctionsNewFileExistsError",
      "MissingFunctionSlugError",
      "FunctionEntrypointExistsError",
      "ConflictingFunctionDownloadFlagsError",
      "ConflictingFunctionDeployFlagsError",
      "FunctionDownloadNotFoundError",
      "FunctionNotFoundError",
      "NoFunctionsToDeployError",
      "LegacyBootstrapInvalidTemplateError",
      "LegacyTestNewFileExistsError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "provide_flags",
      });
    }

    expect(classifyCliErrorActionability({ _tag: "InitParseSettingsError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:InitParseSettingsError",
      has_suggestion: true,
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({ _tag: "FunctionsDevEdgeRuntimeDisabledError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:FunctionsDevEdgeRuntimeDisabledError",
      has_suggestion: true,
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyInvalidOutputFormatError" })).toMatchObject(
      {
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: "tag:LegacyInvalidOutputFormatError",
        has_suggestion: false,
        suggestion_type: "none",
      },
    );

    expect(classifyCliErrorActionability({ _tag: "LegacyDbQueryExecError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:LegacyDbQueryExecError",
      has_suggestion: false,
      suggestion_type: "none",
    });

    for (const tag of [
      "LegacyDbPullInSyncError",
      "LegacyDbExecError",
      "LegacyDbCopyError",
      "LegacyDbLintListSchemasError",
      "LegacyDbLintEnableCheckError",
      "LegacyDbLintQueryError",
      "LegacyDbLintMalformedJsonError",
      "LegacyDbAdvisorsSetupError",
      "LegacyDbAdvisorsQueryError",
      "LegacyMigrationApplyError",
      "LegacyMigrationDropError",
      "LegacyMigrationSeedError",
      "LegacyMigrationVaultError",
      "LegacyMigrationRepairUpdateError",
      "LegacyDeclarativeEdgeRuntimeError",
      "LegacyDeclarativeEmptyOutputError",
      "LegacyDeclarativeParseOutputError",
      "LegacyDeclarativeNoFilesGeneratedError",
      "LegacyDeclarativeDiffError",
      "LegacyDeclarativeApplyError",
      "LegacyMigraDiffError",
      "LegacyMigraSchemaLoadError",
      "LegacyDbLintFailOnError",
      "LegacyDbAdvisorsFailOnError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: false,
        suggestion_type: "none",
      });
    }
  });

  test("splits broad Docker wrapper failures by safe static prefixes", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "LegacyDockerRunError",
        message: "failed to run docker. Docker Desktop is a prerequisite for local development.",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "docker_not_running",
      error_fingerprint: "tag:LegacyDockerRunError:docker_not_running",
      suggestion_type: "start_docker",
    });

    const pullFailure = classifyCliErrorActionability({
      _tag: "LegacyDockerRunError",
      message:
        "failed to pull docker image from all registries: registry.example/private/image:latest attempt 1: unauthorized",
    });
    expect(pullFailure).toMatchObject({
      error_kind: "external_service",
      error_category: "network",
      error_fingerprint: "tag:LegacyDockerRunError:registry_pull",
      suggestion_type: "rerun_debug",
    });
    expect(JSON.stringify(pullFailure)).not.toContain("registry.example/private/image");

    expect(
      classifyCliErrorActionability({
        _tag: "LegacyDockerRunError",
        message:
          "failed to pull docker image from all registries: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "docker_not_running",
      error_fingerprint: "tag:LegacyDockerRunError:docker_not_running",
      suggestion_type: "start_docker",
    });
  });

  test("splits Docker pull daemon failures from registry failures", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "DockerPullError",
        detail:
          "Failed to pull Docker image from all registries. postgres attempt 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "docker_not_running",
      error_fingerprint: "tag:DockerPullError:docker_not_running",
      suggestion_type: "start_docker",
    });

    const pullFailure = classifyCliErrorActionability({
      _tag: "DockerPullError",
      detail:
        "Failed to pull Docker image from all registries. registry.example/private/image:latest attempt 1: unauthorized",
    });
    expect(pullFailure).toMatchObject({
      error_kind: "external_service",
      error_category: "network",
      error_fingerprint: "tag:DockerPullError:registry_pull",
      suggestion_type: "rerun_debug",
    });
    expect(JSON.stringify(pullFailure)).not.toContain("registry.example/private/image");
  });

  test("classifies database connection and migration drift remediations", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyDbConnectError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyDbConnectError",
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({ _tag: "LegacyDbConfigConnectTempRoleError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyDbConfigConnectTempRoleError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyDbConfigPoolerLoginError" })).toMatchObject(
      {
        error_kind: "user_actionable",
        error_category: "db_connection",
        error_fingerprint: "tag:LegacyDbConfigPoolerLoginError",
        suggestion_type: "update_config",
      },
    );

    expect(classifyCliErrorActionability({ _tag: "LegacyTestDbEnablePgtapError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyTestDbEnablePgtapError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyDbDumpRunError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyDbDumpRunError",
      suggestion_type: "update_config",
    });

    for (const tag of [
      "LegacyDbPullDumpError",
      "LegacyDbLintBeginTxError",
      "LegacyDbAdvisorsBeginTxError",
      "LegacyDeclarativeShadowDbError",
      "LegacyPgDeltaSslProbeError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "db_connection",
        error_fingerprint: `tag:${tag}`,
        suggestion_type: "update_config",
      });
    }

    expect(classifyCliErrorActionability({ _tag: "LegacyDbConfigIpv6Error" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyDbConfigIpv6Error",
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({ _tag: "LegacyDbPullMigrationConflictError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "migration_drift",
      error_fingerprint: "tag:LegacyDbPullMigrationConflictError",
      suggestion_type: "repair_migration",
    });

    expect(
      classifyCliErrorActionability({ _tag: "LegacyMigrationMissingRemoteError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "migration_drift",
      error_fingerprint: "tag:LegacyMigrationMissingRemoteError",
      suggestion_type: "repair_migration",
    });

    for (const tag of [
      "LegacyMigrationTargetFlagsError",
      "LegacyMigrationPasswordFlagsError",
      "LegacyMigrationInvalidVersionError",
      "LegacyMigrationFileNotFoundError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "provide_flags",
      });
    }
  });

  test("splits broad stack build failures by safe static details", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "StackBuildError",
        detail: "imgproxy requires storage to be enabled",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:StackBuildError:invalid_config",
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "StackBuildError",
        detail: "Failed to persist stack cleanup metadata",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:StackBuildError:invalid_config",
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "StackBuildError",
        detail: "Failed to prepare stack assets",
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "network",
      error_fingerprint: "tag:StackBuildError:asset_preparation",
      suggestion_type: "rerun_debug",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "StackBuildError",
        detail: "Failed to build dependency graph",
      }),
    ).toMatchObject({
      error_kind: "internal_bug",
      error_category: "impossible_state",
      error_fingerprint: "tag:StackBuildError:internal_build",
      suggestion_type: "rerun_debug",
    });
  });

  test("classifies invalid local stack state as user-recoverable config", () => {
    expect(classifyCliErrorActionability({ _tag: "InvalidStackStateError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:InvalidStackStateError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "InvalidStackMetadataError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:InvalidStackMetadataError",
      suggestion_type: "update_config",
    });

    expect(
      classifyCliErrorActionability({ _tag: "UnsupportedStackMetadataVersionError" }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:UnsupportedStackMetadataVersionError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyDbConfigLoadError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyDbConfigLoadError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyDbConfigParseUrlError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyDbConfigParseUrlError",
      suggestion_type: "update_config",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyStorageConfigError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyStorageConfigError",
      suggestion_type: "update_config",
    });

    for (const tag of [
      "ProjectConfigParseError",
      "ProjectEnvParseError",
      "LegacyConfigPushLoadConfigError",
      "LegacySeedConfigLoadError",
      "LegacySecretsConfigParseError",
      "LegacyDomainsCnameError",
      "LegacyDbDiffWriteError",
      "LegacyGenSigningKeyConfigParseError",
      "LegacyGenSigningKeyDecodeError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: `tag:${tag}`,
        suggestion_type: "update_config",
      });
    }
  });

  test("classifies normalized local stack lifecycle errors as user-recoverable config", () => {
    for (const tag of [
      "NoRunningStackError",
      "StateNotFoundError",
      "ServiceReadyError",
      "DaemonStartError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "update_config",
        suggested_command: "supabase start",
      });
    }

    for (const tag of ["DaemonStillRunningError", "StackAlreadyRunningError"]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "update_config",
        suggested_command: "supabase stop",
      });
    }
  });

  test("classifies port allocation StackError wrappers as local config failures", () => {
    const error = new Error("Failed to allocate a free port");
    error.name = "StackError";
    Object.assign(error, { code: "PORT_ALLOCATION" });

    expect(classifyCliErrorActionability(error)).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_config",
      error_fingerprint: "error:StackError:port_allocation",
      has_suggestion: true,
      suggestion_type: "update_config",
    });

    const unknown = new Error("Failed to start stack");
    unknown.name = "StackError";
    Object.assign(unknown, { code: "UNKNOWN" });

    expect(classifyCliErrorActionability(unknown)).toMatchObject({
      error_kind: "unknown",
      error_category: "unknown",
      error_fingerprint: "error:StackError:unknown",
      has_suggestion: false,
      suggestion_type: "none",
    });
  });

  test("classifies local permission failures as user-actionable permission errors", () => {
    for (const tag of [
      "LegacyDeleteTokenError",
      "LegacyCredentialDeleteError",
      "LegacyUnlinkTempRemovalError",
      "LegacyStorageMissingApiKeyError",
      "LegacyFunctionsNewWriteError",
      "LegacyGenSigningKeyReadError",
      "LegacyGenSigningKeyWriteError",
      "LegacyMigrationFetchWriteError",
      "LegacyMigrationNewWriteError",
      "LegacyMigrationsReadError",
      "LegacyDbPullWriteError",
      "LegacyDeclarativeWriteError",
      "LegacyTestNewWriteError",
      "LegacyBootstrapWorkdirReadError",
      "LegacyProfileSaveError",
      "LegacyInspectReportMkdirError",
      "LegacyInspectReportWriteError",
      "FileWatcherError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "permission",
        error_fingerprint: `tag:${tag}`,
        suggestion_type: "update_config",
      });
    }
  });

  test("infers legacy HTTP wrapper network and status failures", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyBranchesListNetworkError" })).toMatchObject(
      {
        error_kind: "external_service",
        error_category: "network",
        error_fingerprint: "tag:LegacyBranchesListNetworkError",
        suggestion_type: "rerun_debug",
      },
    );

    expect(
      classifyCliErrorActionability({ _tag: "LegacyBackupListUnexpectedStatusError" }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacyBackupListUnexpectedStatusError",
      has_suggestion: false,
      suggestion_type: "none",
    });

    expect(
      classifyCliErrorActionability({ _tag: "LegacyConfigPushApiReadStatusError" }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacyConfigPushApiReadStatusError",
      has_suggestion: false,
      suggestion_type: "none",
    });

    for (const tag of [
      "LegacyBootstrapHealthError",
      "LegacyDbAdvisorsSecurityStatusError",
      "LegacyDbAdvisorsPerformanceStatusError",
      "LegacyBranchesPrimaryNotFoundError",
      "InvalidFunctionDownloadResponseError",
      "UnsafeFunctionDownloadPathError",
      "LegacyPostgresConfigGetUnmarshalError",
      "LegacyPostgresConfigUpdateUnmarshalError",
      "LegacyPostgresConfigDeleteUnmarshalError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "external_service",
        error_category: "api_status",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: false,
        suggestion_type: "none",
      });
    }

    for (const tag of [
      "LegacyBootstrapTemplateListError",
      "LegacyBootstrapTemplateDownloadError",
      "LegacyDbAdvisorsSecurityNetworkError",
      "LegacyDbAdvisorsPerformanceNetworkError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "external_service",
        error_category: "network",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: true,
        suggestion_type: "rerun_debug",
      });
    }
  });

  test("splits ApiError transport failures from status failures", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "ApiError",
        detail: "fetch failed",
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "network",
      error_fingerprint: "tag:ApiError:network",
      suggestion_type: "rerun_debug",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "ApiError",
        statusCode: 401,
        detail: "401 Unauthorized",
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:ApiError:auth",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "ApiError",
        statusCode: 503,
        detail: "503 Service Unavailable",
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:ApiError:api_status",
      suggestion_type: "none",
    });
  });

  test("splits generated API client transport failures from status failures", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "HttpClientError",
        reason: { _tag: "TransportError" },
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "network",
      error_fingerprint: "tag:HttpClientError:network",
      suggestion_type: "rerun_debug",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "HttpClientError",
        reason: { _tag: "StatusCodeError" },
        response: { status: 401 },
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:HttpClientError:auth",
      suggestion_type: "login",
      suggested_command: "supabase login",
    });

    expect(
      classifyCliErrorActionability({
        _tag: "HttpClientError",
        reason: { _tag: "StatusCodeError" },
        response: { status: 503 },
      }),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:HttpClientError:api_status",
      suggestion_type: "none",
    });

    for (const tag of ["HttpBodyError", "SchemaError"]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "external_service",
        error_category: "api_status",
        error_fingerprint: `tag:${tag}:api_response`,
        has_suggestion: false,
        suggestion_type: "none",
      });

      expect(classifyCliErrorActionability({ _tag: tag, response: { status: 200 } })).toMatchObject(
        {
          error_kind: "external_service",
          error_category: "api_status",
          error_fingerprint: `tag:${tag}:api_response`,
          has_suggestion: false,
          suggestion_type: "none",
        },
      );

      expect(classifyCliErrorActionability({ _tag: tag, requestInput: true })).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: `tag:${tag}:request_input`,
        has_suggestion: true,
        suggestion_type: "provide_flags",
      });
    }
  });

  test("buckets user cancellations separately from unknown failures", () => {
    for (const tag of [
      "LegacySecretsUnsetCancelledError",
      "LegacyOperationCanceledError",
      "FunctionDeployCancelledError",
      "LegacyBootstrapOverwriteDeclinedError",
    ]) {
      expect(classifyCliErrorActionability({ _tag: tag })).toMatchObject({
        error_kind: "user_cancelled",
        error_category: "cancelled",
        error_fingerprint: `tag:${tag}`,
        has_suggestion: false,
        suggestion_type: "none",
      });
    }
  });

  test("unwraps single-error ShowHelp envelopes for parser failures", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "ShowHelp",
        errors: [{ _tag: "MissingOption", option: "project-ref" }],
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:MissingOption",
    });
  });

  test("keeps unknown classifications sanitized", () => {
    const classified = classifyCliErrorActionability({
      _tag: "UnexpectedFailure",
      message: "failed for /Users/person/project with token secret-token",
      detail: "host db.example.internal",
      suggestion: "paste a private value",
    });

    expect(classified).toEqual({
      error_kind: "unknown",
      error_category: "unknown",
      error_fingerprint: "tag:UnexpectedFailure",
      has_suggestion: false,
      suggestion_type: "none",
    });
    expect(JSON.stringify(classified)).not.toContain("/Users/person/project");
    expect(JSON.stringify(classified)).not.toContain("secret-token");
    expect(JSON.stringify(classified)).not.toContain("db.example.internal");
  });

  test("does not fingerprint arbitrary string error contents", () => {
    expect(classifyCliErrorActionability("panic with token secret-token")).toEqual({
      error_kind: "unknown",
      error_category: "unknown",
      error_fingerprint: "string:unknown",
      has_suggestion: false,
      suggestion_type: "none",
    });
  });

  test("classifies native JavaScript exceptions as internal bugs", () => {
    const classified = classifyCliErrorActionability(new TypeError("cannot read properties"));

    expect(classified).toEqual({
      error_kind: "internal_bug",
      error_category: "panic",
      error_fingerprint: "error:TypeError",
      has_suggestion: true,
      suggestion_type: "rerun_debug",
    });
    expect(JSON.stringify(classified)).not.toContain("cannot read properties");
  });

  test("classifies browser login crypto failures as internal bugs", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyLoginCryptoError" })).toEqual({
      error_kind: "internal_bug",
      error_category: "panic",
      error_fingerprint: "tag:LegacyLoginCryptoError",
      has_suggestion: true,
      suggestion_type: "rerun_debug",
    });
  });
});
