import { Cause, Option } from "effect";

export const CliErrorKind = {
  UserActionable: "user_actionable",
  InternalBug: "internal_bug",
  ExternalService: "external_service",
  UserCancelled: "user_cancelled",
  Unknown: "unknown",
} as const;

export type CliErrorKind = (typeof CliErrorKind)[keyof typeof CliErrorKind];

export const CliErrorCategory = {
  Auth: "auth",
  MissingProjectRef: "missing_project_ref",
  ProjectNotLinked: "project_not_linked",
  DockerNotRunning: "docker_not_running",
  InvalidConfig: "invalid_config",
  DbConnection: "db_connection",
  MigrationDrift: "migration_drift",
  Permission: "permission",
  PlanLimit: "plan_limit",
  InvalidInput: "invalid_input",
  Network: "network",
  ApiStatus: "api_status",
  Cancelled: "cancelled",
  Panic: "panic",
  ImpossibleState: "impossible_state",
  Unknown: "unknown",
} as const;

export type CliErrorCategory = (typeof CliErrorCategory)[keyof typeof CliErrorCategory];

export const CliSuggestionType = {
  Login: "login",
  LinkProject: "link_project",
  StartDocker: "start_docker",
  ProvideFlags: "provide_flags",
  SetEnvVar: "set_env_var",
  RepairMigration: "repair_migration",
  UpdateConfig: "update_config",
  UpgradePlan: "upgrade_plan",
  RerunDebug: "rerun_debug",
  None: "none",
} as const;

export type CliSuggestionType = (typeof CliSuggestionType)[keyof typeof CliSuggestionType];

export interface CliErrorActionability {
  readonly error_kind: CliErrorKind;
  readonly error_category: CliErrorCategory;
  readonly error_fingerprint: string;
  readonly has_suggestion: boolean;
  readonly suggestion_type: CliSuggestionType;
  readonly suggested_command?: string;
  readonly workflow?: string;
}

export const CliErrorActionabilityMetricDefinitions = {
  strictRecovery: {
    id: "same_command_success_same_session",
    description:
      "A user-actionable error is recovered when the same command later succeeds in the same PostHog session.",
  },
  repeatError: {
    id: "same_command_same_error_same_session_before_success",
    description:
      "A user-actionable error repeats when the same command fails again with the same error fingerprint in the same PostHog session before success.",
  },
  internalUnknownBugRate: {
    id: "failed_commands_internal_bug_or_unknown",
    description:
      "Internal/unknown bug failure rate is the share of failed commands classified as internal_bug or unknown.",
  },
} as const;

type ErrorRecord = Record<string, unknown>;

type ActionabilityTemplate = Omit<CliErrorActionability, "error_fingerprint">;

interface ClassifiedTemplate {
  readonly template: ActionabilityTemplate;
  readonly fingerprint_suffix?: string;
}

const authLoginTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.Auth,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.Login,
  suggested_command: "supabase login",
} satisfies ActionabilityTemplate;

const authTokenTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.Auth,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.SetEnvVar,
} satisfies ActionabilityTemplate;

const provideFlagsTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.InvalidInput,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.ProvideFlags,
} satisfies ActionabilityTemplate;

const externalNetworkTemplate = {
  error_kind: CliErrorKind.ExternalService,
  error_category: CliErrorCategory.Network,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.RerunDebug,
} satisfies ActionabilityTemplate;

const externalStatusTemplate = {
  error_kind: CliErrorKind.ExternalService,
  error_category: CliErrorCategory.ApiStatus,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
} satisfies ActionabilityTemplate;

const cancelledTemplate = {
  error_kind: CliErrorKind.UserCancelled,
  error_category: CliErrorCategory.Cancelled,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
} satisfies ActionabilityTemplate;

const planLimitTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.PlanLimit,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.UpgradePlan,
} satisfies ActionabilityTemplate;

const invalidInputTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.InvalidInput,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
} satisfies ActionabilityTemplate;

const invalidConfigTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.InvalidConfig,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.UpdateConfig,
} satisfies ActionabilityTemplate;

const dbFindingTemplate = {
  ...invalidConfigTemplate,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
} satisfies ActionabilityTemplate;

const startStackTemplate = {
  ...invalidConfigTemplate,
  suggested_command: "supabase start",
} satisfies ActionabilityTemplate;

const stopStackTemplate = {
  ...invalidConfigTemplate,
  suggested_command: "supabase stop",
} satisfies ActionabilityTemplate;

const dbConnectionTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.DbConnection,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.UpdateConfig,
} satisfies ActionabilityTemplate;

const migrationDriftTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.MigrationDrift,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.RepairMigration,
} satisfies ActionabilityTemplate;

const permissionTemplate = {
  error_kind: CliErrorKind.UserActionable,
  error_category: CliErrorCategory.Permission,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.UpdateConfig,
} satisfies ActionabilityTemplate;

const accountAccessTemplate = {
  ...permissionTemplate,
  suggestion_type: CliSuggestionType.Login,
  suggested_command: "supabase login",
} satisfies ActionabilityTemplate;

const internalPanicTemplate = {
  error_kind: CliErrorKind.InternalBug,
  error_category: CliErrorCategory.Panic,
  has_suggestion: true,
  suggestion_type: CliSuggestionType.RerunDebug,
} satisfies ActionabilityTemplate;

const defaultUnknownTemplate: ActionabilityTemplate = {
  error_kind: CliErrorKind.Unknown,
  error_category: CliErrorCategory.Unknown,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
};

const actionabilityByTag = {
  InvalidTokenError: authLoginTemplate,
  LegacyInvalidAccessTokenError: authLoginTemplate,
  LegacyLinkAuthTokenError: authLoginTemplate,
  LegacyPlatformAuthRequiredError: authLoginTemplate,
  PlatformAuthRequiredError: authLoginTemplate,
  LegacyDbAdvisorsInvalidTokenError: authLoginTemplate,
  LegacyDbAdvisorsNotLoggedInError: authLoginTemplate,
  LegacyDbQueryLoginRequiredError: authLoginTemplate,
  LegacyLoginCryptoError: internalPanicTemplate,
  LegacyLoginDecryptError: authLoginTemplate,
  LegacyLoginFailedError: authLoginTemplate,
  LoginFailedError: authLoginTemplate,
  LegacyLoginSaveTokenError: authLoginTemplate,
  LegacyLoginMissingTokenError: authTokenTemplate,
  LegacyProfileSaveError: permissionTemplate,
  LegacyStorageAuthTokenError: authLoginTemplate,
  LegacyDbConnectError: dbConnectionTemplate,
  LegacyDbExecError: dbFindingTemplate,
  LegacyDbCopyError: dbFindingTemplate,
  LegacyDbConfigConnectTempRoleError: dbConnectionTemplate,
  LegacyDbConfigIpv6Error: dbConnectionTemplate,
  LegacyDbConfigPoolerLoginError: dbConnectionTemplate,
  LegacyDbConfigLoadError: invalidConfigTemplate,
  LegacyDbConfigParseUrlError: invalidConfigTemplate,
  ProjectEnvParseError: invalidConfigTemplate,
  ProjectConfigParseError: invalidConfigTemplate,
  LegacyConfigPushLoadConfigError: invalidConfigTemplate,
  LegacySeedConfigLoadError: invalidConfigTemplate,
  LegacySecretsConfigParseError: invalidConfigTemplate,
  LegacyDbPullMigrationConflictError: migrationDriftTemplate,
  LegacyMigrationMissingLocalError: migrationDriftTemplate,
  LegacyMigrationMissingRemoteError: migrationDriftTemplate,
  LegacyMigrationApplyError: dbFindingTemplate,
  LegacyMigrationDropError: dbFindingTemplate,
  LegacyMigrationSeedError: dbFindingTemplate,
  LegacyMigrationVaultError: dbFindingTemplate,
  LegacyMigrationTargetFlagsError: provideFlagsTemplate,
  LegacyMigrationPasswordFlagsError: provideFlagsTemplate,
  LegacyMigrationInvalidVersionError: provideFlagsTemplate,
  LegacyMigrationFileNotFoundError: provideFlagsTemplate,
  LegacyMigrationLastZeroError: provideFlagsTemplate,
  LegacyMigrationLastTooLargeError: provideFlagsTemplate,
  LegacyMigrationFetchWriteError: permissionTemplate,
  LegacyMigrationNewWriteError: permissionTemplate,
  LegacyMigrationRepairUpdateError: dbFindingTemplate,
  LegacyMigrationsReadError: permissionTemplate,
  LegacyDeleteTokenError: permissionTemplate,
  LegacyCredentialDeleteError: permissionTemplate,
  ProjectNotLinkedError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.ProjectNotLinked,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  LegacyProjectNotLinkedError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.ProjectNotLinked,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  LegacyProjectRefRequiredError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.MissingProjectRef,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  ProjectRefRequiredError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.MissingProjectRef,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  InvalidProjectLinkStateError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  LegacyProjectRefReadError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  LegacyLinkMissingKeyError: permissionTemplate,
  LegacyUnlinkRefReadError: invalidConfigTemplate,
  LegacyUnlinkTempRemovalError: permissionTemplate,
  NoAccessibleProjectsError: accountAccessTemplate,
  LegacyProjectPausedError: {
    ...invalidConfigTemplate,
  },
  InvalidServiceVersionOverrideError: provideFlagsTemplate,
  FunctionsDevEdgeRuntimeDisabledError: invalidConfigTemplate,
  LegacyInvalidProjectRefError: invalidInputTemplate,
  LegacyInvalidSecretPairError: invalidInputTemplate,
  LegacySecretsEnvFileOpenError: invalidInputTemplate,
  LegacySecretsEnvFileParseError: invalidInputTemplate,
  LegacySecretsNoArgumentsError: provideFlagsTemplate,
  LegacyDomainsCnameError: invalidConfigTemplate,
  InitExperimentalRequiredError: provideFlagsTemplate,
  InitAlreadyExistsError: provideFlagsTemplate,
  InitParseSettingsError: invalidConfigTemplate,
  LegacySsoInvalidUuidError: invalidInputTemplate,
  LegacySsoMutexFlagError: invalidInputTemplate,
  LegacySsoAddMetadataFileError: provideFlagsTemplate,
  LegacySsoUpdateMetadataFileError: provideFlagsTemplate,
  LegacySsoAddAttributeMappingFileError: provideFlagsTemplate,
  LegacySsoUpdateAttributeMappingFileError: provideFlagsTemplate,
  LegacySsoMetadataUrlInvalidError: provideFlagsTemplate,
  LegacySsoMetadataUrlNonUtf8Error: provideFlagsTemplate,
  LegacySsoShowNotFoundError: invalidInputTemplate,
  LegacySsoUpdateNotFoundError: invalidInputTemplate,
  LegacySsoRemoveNotFoundError: invalidInputTemplate,
  LegacyBootstrapInvalidTemplateError: provideFlagsTemplate,
  LegacyBootstrapTemplateListError: externalNetworkTemplate,
  LegacyBootstrapWorkdirReadError: permissionTemplate,
  LegacyBootstrapOverwriteDeclinedError: cancelledTemplate,
  LegacyBootstrapTemplateDownloadError: externalNetworkTemplate,
  LegacyBootstrapHealthError: externalStatusTemplate,
  LegacyBranchesBranchingDisabledError: {
    ...invalidInputTemplate,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpdateConfig,
    suggested_command: "supabase branches create",
  },
  LegacyBranchesBranchNameEmptyError: provideFlagsTemplate,
  NoBranchNameError: provideFlagsTemplate,
  BranchAlreadyExistsError: provideFlagsTemplate,
  BranchNotFoundError: provideFlagsTemplate,
  LegacyBranchesPrimaryNotFoundError: externalStatusTemplate,
  PlatformInputError: provideFlagsTemplate,
  PlatformRouteNotFoundError: provideFlagsTemplate,
  PlatformMethodSelectionError: provideFlagsTemplate,
  LegacyInvalidOutputFormatError: invalidInputTemplate,
  LegacyBranchesEnvNotSupportedError: invalidInputTemplate,
  LegacyFunctionsEnvNotSupportedError: invalidInputTemplate,
  LegacyNetworkBansEnvNotSupportedError: invalidInputTemplate,
  LegacyOrgsEnvNotSupportedError: invalidInputTemplate,
  LegacyProjectsEnvNotSupportedError: invalidInputTemplate,
  LegacySecretsEnvNotSupportedError: invalidInputTemplate,
  LegacyServicesEnvNotSupportedError: invalidInputTemplate,
  LegacySnippetsEnvNotSupportedError: invalidInputTemplate,
  LegacySsoShowEnvNotSupportedError: invalidInputTemplate,
  LegacyExperimentalRequiredError: provideFlagsTemplate,
  LegacyDbDumpRequiresDataOnlyError: provideFlagsTemplate,
  LegacyDbDumpMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyDbDumpOpenFileError: provideFlagsTemplate,
  LegacyDbDumpRunError: dbConnectionTemplate,
  LegacyDbDiffTargetFlagsError: provideFlagsTemplate,
  LegacyDbDiffEngineConflictError: provideFlagsTemplate,
  LegacyDbDiffExplicitFlagsError: provideFlagsTemplate,
  LegacyDbDiffUnknownTargetError: provideFlagsTemplate,
  LegacyDbDiffWriteError: invalidConfigTemplate,
  LegacyDbQueryMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyDbQueryReadFileError: provideFlagsTemplate,
  LegacyDbQueryNoStdinSqlError: provideFlagsTemplate,
  LegacyDbQueryNoSqlError: provideFlagsTemplate,
  LegacyDbQueryExecError: invalidInputTemplate,
  LegacyDbPullTargetFlagsError: provideFlagsTemplate,
  LegacyDbPullEngineConflictError: provideFlagsTemplate,
  LegacyDbPullInSyncError: dbFindingTemplate,
  LegacyDbPullWriteError: permissionTemplate,
  LegacyDbPullDumpError: dbConnectionTemplate,
  LegacyDbLintMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyDbLintBeginTxError: dbConnectionTemplate,
  LegacyDbLintListSchemasError: dbFindingTemplate,
  LegacyDbLintEnableCheckError: dbFindingTemplate,
  LegacyDbLintQueryError: dbFindingTemplate,
  LegacyDbLintMalformedJsonError: dbFindingTemplate,
  LegacyDbAdvisorsMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyDbAdvisorsBeginTxError: dbConnectionTemplate,
  LegacyDbAdvisorsSetupError: dbFindingTemplate,
  LegacyDbAdvisorsQueryError: dbFindingTemplate,
  LegacyDbAdvisorsSecurityNetworkError: externalNetworkTemplate,
  LegacyDbAdvisorsSecurityStatusError: externalStatusTemplate,
  LegacyDbAdvisorsPerformanceNetworkError: externalNetworkTemplate,
  LegacyDbAdvisorsPerformanceStatusError: externalStatusTemplate,
  LegacyDeclarativeNotEnabledError: provideFlagsTemplate,
  LegacyDeclarativeMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyDeclarativeNonInteractiveError: provideFlagsTemplate,
  LegacyDeclarativeInvalidDbUrlError: provideFlagsTemplate,
  LegacyDeclarativeEdgeRuntimeError: dbFindingTemplate,
  LegacyDeclarativeShadowDbError: dbConnectionTemplate,
  LegacyDeclarativeEmptyOutputError: dbFindingTemplate,
  LegacyDeclarativeParseOutputError: dbFindingTemplate,
  LegacyDeclarativeWriteError: permissionTemplate,
  LegacyDeclarativeNoFilesGeneratedError: dbFindingTemplate,
  LegacyDeclarativeDiffError: dbFindingTemplate,
  LegacyDeclarativeApplyError: dbFindingTemplate,
  LegacyMigraDiffError: dbFindingTemplate,
  LegacyMigraSchemaLoadError: dbFindingTemplate,
  LegacyPostgresConfigInvalidConfigValueError: provideFlagsTemplate,
  LegacyPostgresConfigGetUnmarshalError: externalStatusTemplate,
  LegacyPostgresConfigUpdateUnmarshalError: externalStatusTemplate,
  LegacyPostgresConfigDeleteUnmarshalError: externalStatusTemplate,
  LegacyTestDbMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyTestDbRunError: dbFindingTemplate,
  LegacyInspectMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyInspectReportMkdirError: permissionTemplate,
  LegacyInspectReportWriteError: permissionTemplate,
  LegacyNetworkBansInvalidIpError: invalidInputTemplate,
  LegacyNetworkRestrictionsInvalidCidrError: invalidInputTemplate,
  LegacyNetworkRestrictionsPrivateIpError: invalidInputTemplate,
  LegacySslEnforcementMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacySslEnforcementNoEnableDisableFlagError: provideFlagsTemplate,
  LegacyProjectsCreateMissingArgError: provideFlagsTemplate,
  LegacyProjectsCreateNameEmptyError: provideFlagsTemplate,
  LegacyProjectsDeleteRefRequiredError: provideFlagsTemplate,
  LegacyProjectsDeleteNotFoundError: provideFlagsTemplate,
  LegacyGenSigningKeyConfigParseError: invalidConfigTemplate,
  LegacyGenSigningKeyReadError: permissionTemplate,
  LegacyGenSigningKeyDecodeError: invalidConfigTemplate,
  LegacyGenSigningKeyWriteError: permissionTemplate,
  LegacyInvalidGenTypesDurationError: provideFlagsTemplate,
  LegacyInvalidGenTypesDatabaseUrlError: provideFlagsTemplate,
  LegacyPgDeltaSslProbeError: dbConnectionTemplate,
  LegacySnippetsInvalidIdError: invalidInputTemplate,
  LegacyStorageInvalidUrlError: provideFlagsTemplate,
  LegacyStorageUrlParseError: provideFlagsTemplate,
  LegacyStorageMissingFlagError: provideFlagsTemplate,
  LegacyStorageMutuallyExclusiveFlagsError: provideFlagsTemplate,
  LegacyStorageConfigError: invalidConfigTemplate,
  LegacyStorageMissingApiKeyError: permissionTemplate,
  LegacyStorageObjectNotFoundError: invalidInputTemplate,
  LegacyStorageFileError: invalidInputTemplate,
  LegacyStorageUnsupportedOperationError: provideFlagsTemplate,
  LegacyStorageCopyBetweenBucketsError: provideFlagsTemplate,
  LegacyStorageUnsupportedMoveError: provideFlagsTemplate,
  LegacyStorageMissingPathError: provideFlagsTemplate,
  LegacyStorageMissingBucketError: provideFlagsTemplate,
  LegacySeedMutuallyExclusiveFlagsError: provideFlagsTemplate,
  InvalidFunctionDeploySlugError: provideFlagsTemplate,
  InvalidFunctionSlugError: provideFlagsTemplate,
  LegacyFunctionsNewInvalidSlugError: provideFlagsTemplate,
  LegacyFunctionsNewFileExistsError: provideFlagsTemplate,
  LegacyFunctionsNewWriteError: permissionTemplate,
  MissingFunctionSlugError: provideFlagsTemplate,
  FunctionEntrypointExistsError: provideFlagsTemplate,
  ConflictingFunctionDownloadFlagsError: provideFlagsTemplate,
  ConflictingFunctionDeployFlagsError: provideFlagsTemplate,
  FunctionDownloadNotFoundError: provideFlagsTemplate,
  FunctionNotFoundError: provideFlagsTemplate,
  InvalidFunctionDownloadResponseError: externalStatusTemplate,
  UnsafeFunctionDownloadPathError: externalStatusTemplate,
  NoFunctionsToDeployError: provideFlagsTemplate,
  FileWatcherError: permissionTemplate,
  UnsupportedLogsOutputFormatError: provideFlagsTemplate,
  LegacyTestNewFileExistsError: provideFlagsTemplate,
  LegacyTestNewWriteError: permissionTemplate,
  LegacyDbAdvisorsFailOnError: dbFindingTemplate,
  LegacyDbLintFailOnError: dbFindingTemplate,
  LegacyTestDbEnablePgtapError: dbConnectionTemplate,
  MissingOption: invalidInputTemplate,
  NoTtyError: authTokenTemplate,
  NonInteractiveError: provideFlagsTemplate,
  UnknownSubcommand: invalidInputTemplate,
  UnrecognizedOption: invalidInputTemplate,
  InvalidStackMetadataError: invalidConfigTemplate,
  UnsupportedStackMetadataVersionError: invalidConfigTemplate,
  InvalidStackStateError: invalidConfigTemplate,
  NoRunningStackError: startStackTemplate,
  StateNotFoundError: startStackTemplate,
  ServiceReadyError: startStackTemplate,
  DaemonStartError: startStackTemplate,
  DaemonStillRunningError: stopStackTemplate,
  StackAlreadyRunningError: stopStackTemplate,
} satisfies Record<string, ActionabilityTemplate>;

const actionabilityByTagLookup = new Map<string, ActionabilityTemplate>(
  Object.entries(actionabilityByTag),
);

function isErrorRecord(value: unknown): value is ErrorRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: ErrorRecord, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function readNumber(value: ErrorRecord, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function readBoolean(value: ErrorRecord, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function readRecord(value: ErrorRecord, key: string): ErrorRecord | undefined {
  const field = value[key];
  return isErrorRecord(field) ? field : undefined;
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value) ? value : undefined;
}

function readErrorTag(error: unknown): string | undefined {
  if (!isErrorRecord(error)) return undefined;
  return safeIdentifier(readString(error, "_tag"));
}

function readErrorName(error: unknown): string | undefined {
  if (error instanceof Error) return safeIdentifier(error.name);
  if (!isErrorRecord(error)) return undefined;
  return safeIdentifier(readString(error, "name"));
}

function fingerprint(prefix: string, identifier: string | undefined, suffix?: string): string {
  const base = identifier === undefined ? `${prefix}:unknown` : `${prefix}:${identifier}`;
  return suffix === undefined ? base : `${base}:${suffix}`;
}

function classifyShowHelp(error: ErrorRecord): CliErrorActionability | undefined {
  const errors = error["errors"];
  if (!Array.isArray(errors)) return undefined;
  if (errors.length === 1) return classifyCliErrorActionability(errors[0]);
  return {
    ...actionabilityByTag.MissingOption,
    error_fingerprint: "tag:ShowHelp",
  };
}

function hasDockerDaemonDownDetail(message: string | undefined): boolean {
  const detail = message?.toLocaleLowerCase();
  if (detail === undefined) return false;
  return (
    detail.includes("cannot connect to the docker daemon") ||
    detail.includes("docker daemon is not running") ||
    detail.includes("docker desktop is not running") ||
    detail.includes("is the docker daemon running")
  );
}

function classifyLegacyDockerRunError(error: ErrorRecord): ClassifiedTemplate {
  const message = readString(error, "message");
  if (message?.startsWith("failed to run docker.")) {
    return {
      template: {
        error_kind: CliErrorKind.UserActionable,
        error_category: CliErrorCategory.DockerNotRunning,
        has_suggestion: true,
        suggestion_type: CliSuggestionType.StartDocker,
      },
      fingerprint_suffix: "docker_not_running",
    };
  }
  if (message?.startsWith("failed to pull docker image from all registries:")) {
    if (hasDockerDaemonDownDetail(message)) {
      return {
        template: {
          error_kind: CliErrorKind.UserActionable,
          error_category: CliErrorCategory.DockerNotRunning,
          has_suggestion: true,
          suggestion_type: CliSuggestionType.StartDocker,
        },
        fingerprint_suffix: "docker_not_running",
      };
    }
    return {
      template: externalNetworkTemplate,
      fingerprint_suffix: "registry_pull",
    };
  }
  return {
    template: defaultUnknownTemplate,
    fingerprint_suffix: "unknown",
  };
}

function classifyDockerPullError(error: ErrorRecord): ClassifiedTemplate {
  if (hasDockerDaemonDownDetail(textFields(error))) {
    return {
      template: {
        error_kind: CliErrorKind.UserActionable,
        error_category: CliErrorCategory.DockerNotRunning,
        has_suggestion: true,
        suggestion_type: CliSuggestionType.StartDocker,
      },
      fingerprint_suffix: "docker_not_running",
    };
  }
  return {
    template: externalNetworkTemplate,
    fingerprint_suffix: "registry_pull",
  };
}

function classifyStackBuildError(error: ErrorRecord): ClassifiedTemplate {
  const detail = readString(error, "detail");
  if (
    detail?.startsWith('mode "native" only supports') ||
    detail === "imgproxy requires storage to be enabled" ||
    detail === "vector requires analytics to be enabled" ||
    detail === "studio requires pgmeta to be enabled" ||
    detail === "Failed to persist stack cleanup metadata"
  ) {
    return {
      template: {
        error_kind: CliErrorKind.UserActionable,
        error_category: CliErrorCategory.InvalidConfig,
        has_suggestion: true,
        suggestion_type: CliSuggestionType.UpdateConfig,
      },
      fingerprint_suffix: "invalid_config",
    };
  }
  if (detail === "Failed to prepare stack assets") {
    return {
      template: externalNetworkTemplate,
      fingerprint_suffix: "asset_preparation",
    };
  }
  return {
    template: {
      error_kind: CliErrorKind.InternalBug,
      error_category: CliErrorCategory.ImpossibleState,
      has_suggestion: true,
      suggestion_type: CliSuggestionType.RerunDebug,
    },
    fingerprint_suffix: "internal_build",
  };
}

function textFields(error: ErrorRecord): string {
  return ["body", "message", "detail", "suggestion"]
    .flatMap((key) => {
      const value = readString(error, key);
      return value === undefined ? [] : [value.toLowerCase()];
    })
    .join("\n");
}

function hasPlanLimitDetail(error: ErrorRecord): boolean {
  if (readBoolean(error, "upgradeSuggested") === true) return true;
  const text = textFields(error);
  return (
    text.includes("upgrade") ||
    text.includes("billing") ||
    text.includes("entitlement") ||
    text.includes("plan limit") ||
    text.includes("quota") ||
    text.includes("branching limit")
  );
}

function classifySamlDisabledError(error: ErrorRecord): ClassifiedTemplate {
  return hasPlanLimitDetail(error)
    ? {
        template: planLimitTemplate,
        fingerprint_suffix: "plan_limit",
      }
    : {
        template: invalidConfigTemplate,
        fingerprint_suffix: "saml_disabled",
      };
}

function classifyPlanGatedNotFoundError(error: ErrorRecord): ClassifiedTemplate {
  return hasPlanLimitDetail(error)
    ? {
        template: planLimitTemplate,
        fingerprint_suffix: "plan_limit",
      }
    : {
        template: invalidInputTemplate,
      };
}

function classifyGatedStatusError(error: ErrorRecord): ClassifiedTemplate {
  const status = readNumber(error, "status");
  if (status === 401) {
    return {
      template: authLoginTemplate,
      fingerprint_suffix: "auth",
    };
  }
  if (status !== undefined && status >= 400 && status < 500 && hasPlanLimitDetail(error)) {
    return {
      template: planLimitTemplate,
      fingerprint_suffix: "plan_limit",
    };
  }
  return {
    template: externalStatusTemplate,
    fingerprint_suffix: "api_status",
  };
}

function classifyLegacyStatusAuthError(
  tag: string | undefined,
  error: ErrorRecord,
): ClassifiedTemplate | undefined {
  if (tag === undefined) return undefined;
  if (!tag.endsWith("UnexpectedStatusError") && !tag.endsWith("StatusError")) return undefined;

  const status = readNumber(error, "status") ?? readNumber(error, "statusCode");
  if (status !== 401) return undefined;

  return {
    template: authLoginTemplate,
    fingerprint_suffix: "auth",
  };
}

function classifyApiError(error: ErrorRecord): ClassifiedTemplate {
  const statusCode = readNumber(error, "statusCode");
  if (statusCode === 401) {
    return {
      template: authLoginTemplate,
      fingerprint_suffix: "auth",
    };
  }
  return statusCode === undefined
    ? {
        template: externalNetworkTemplate,
        fingerprint_suffix: "network",
      }
    : {
        template: externalStatusTemplate,
        fingerprint_suffix: "api_status",
      };
}

function classifyHttpClientError(error: ErrorRecord): ClassifiedTemplate {
  const reasonTag = readRecord(error, "reason")?._tag;
  const response = readRecord(error, "response");
  const status = response === undefined ? undefined : readNumber(response, "status");
  if (status === 401) {
    return {
      template: authLoginTemplate,
      fingerprint_suffix: "auth",
    };
  }
  if (reasonTag === "StatusCodeError" || response !== undefined) {
    return {
      template: externalStatusTemplate,
      fingerprint_suffix: "api_status",
    };
  }
  return {
    template: externalNetworkTemplate,
    fingerprint_suffix: "network",
  };
}

function hasRequestInputDecodeSignal(error: ErrorRecord): boolean {
  return (
    readBoolean(error, "requestInput") === true ||
    readString(error, "source") === "request" ||
    readString(error, "phase") === "request"
  );
}

function classifyGeneratedClientBodyOrSchemaError(error: ErrorRecord): ClassifiedTemplate {
  return hasRequestInputDecodeSignal(error)
    ? {
        template: provideFlagsTemplate,
        fingerprint_suffix: "request_input",
      }
    : {
        template: externalStatusTemplate,
        fingerprint_suffix: "api_response",
      };
}

function classifyStackError(error: ErrorRecord): ClassifiedTemplate {
  if (readString(error, "code") === "PORT_ALLOCATION") {
    return {
      template: invalidConfigTemplate,
      fingerprint_suffix: "port_allocation",
    };
  }
  return {
    template: defaultUnknownTemplate,
    fingerprint_suffix: "unknown",
  };
}

function isNativeJsExceptionName(name: string | undefined): boolean {
  return (
    name === "TypeError" ||
    name === "ReferenceError" ||
    name === "RangeError" ||
    name === "SyntaxError" ||
    name === "EvalError" ||
    name === "URIError" ||
    name === "AggregateError"
  );
}

function inferTemplateFromTag(tag: string | undefined): ActionabilityTemplate | undefined {
  if (tag === undefined) return undefined;
  if (tag.endsWith("CancelledError") || tag.endsWith("CanceledError")) {
    return cancelledTemplate;
  }
  if (tag.endsWith("NetworkError")) {
    return externalNetworkTemplate;
  }
  if (tag.endsWith("UnexpectedStatusError") || tag.endsWith("StatusError")) {
    return externalStatusTemplate;
  }
  if (/Panic/.test(tag)) {
    return internalPanicTemplate;
  }
  if (/ImpossibleState/.test(tag)) {
    return {
      error_kind: CliErrorKind.InternalBug,
      error_category: CliErrorCategory.ImpossibleState,
      has_suggestion: true,
      suggestion_type: CliSuggestionType.RerunDebug,
    };
  }
  return undefined;
}

export function classifyProcessControlledFailureActionability(
  command: string,
): CliErrorActionability {
  if (command === "db advisors") {
    return {
      ...dbFindingTemplate,
      error_fingerprint: "process_control:db_advisors_fail_on",
    };
  }
  if (command === "db lint") {
    return {
      ...dbFindingTemplate,
      error_fingerprint: "process_control:db_lint_fail_on",
    };
  }
  return {
    ...defaultUnknownTemplate,
    error_fingerprint: "process_control:non_zero_exit",
  };
}

export function classifyCliErrorActionability(error: unknown): CliErrorActionability {
  const tag = readErrorTag(error);
  if (tag === "ShowHelp" && isErrorRecord(error)) {
    const classified = classifyShowHelp(error);
    if (classified !== undefined) return classified;
  }
  if (tag === "LegacyDockerRunError" && isErrorRecord(error)) {
    const classified = classifyLegacyDockerRunError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (tag === "DockerPullError" && isErrorRecord(error)) {
    const classified = classifyDockerPullError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (tag === "StackBuildError" && isErrorRecord(error)) {
    const classified = classifyStackBuildError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (
    (tag === "LegacySsoAddSamlDisabledError" || tag === "LegacySsoListSamlDisabledError") &&
    isErrorRecord(error)
  ) {
    const classified = classifySamlDisabledError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (
    (tag === "LegacySsoUpdateNotFoundError" || tag === "LegacySsoRemoveNotFoundError") &&
    isErrorRecord(error)
  ) {
    const classified = classifyPlanGatedNotFoundError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (
    (tag === "LegacyBranchesCreateUnexpectedStatusError" ||
      tag === "LegacyBranchesUpdateUnexpectedStatusError" ||
      tag === "LegacySsoAddUnexpectedStatusError" ||
      tag === "LegacySsoListUnexpectedStatusError" ||
      tag === "LegacySsoUpdateUnexpectedStatusError" ||
      tag === "LegacySsoRemoveUnexpectedStatusError" ||
      tag === "LegacyVanitySubdomainsActivateUnexpectedStatusError" ||
      tag === "LegacyVanitySubdomainsCheckUnexpectedStatusError") &&
    isErrorRecord(error)
  ) {
    const classified = classifyGatedStatusError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (tag === "ApiError" && isErrorRecord(error)) {
    const classified = classifyApiError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (tag === "HttpClientError" && isErrorRecord(error)) {
    const classified = classifyHttpClientError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if ((tag === "HttpBodyError" || tag === "SchemaError") && isErrorRecord(error)) {
    const classified = classifyGeneratedClientBodyOrSchemaError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
    };
  }
  if (readErrorName(error) === "StackError" && isErrorRecord(error)) {
    const classified = classifyStackError(error);
    return {
      ...classified.template,
      error_fingerprint: fingerprint("error", "StackError", classified.fingerprint_suffix),
    };
  }
  if (isErrorRecord(error)) {
    const classified = classifyLegacyStatusAuthError(tag, error);
    if (classified !== undefined) {
      return {
        ...classified.template,
        error_fingerprint: fingerprint("tag", tag, classified.fingerprint_suffix),
      };
    }
  }

  const template = tag === undefined ? undefined : actionabilityByTagLookup.get(tag);
  const inferred = template ?? inferTemplateFromTag(tag);
  if (inferred !== undefined) {
    return {
      ...inferred,
      error_fingerprint: fingerprint("tag", tag),
    };
  }

  if (tag !== undefined) {
    return {
      ...defaultUnknownTemplate,
      error_fingerprint: fingerprint("tag", tag),
    };
  }

  if (typeof error === "string") {
    return {
      ...defaultUnknownTemplate,
      error_fingerprint: "string:unknown",
    };
  }

  const name = readErrorName(error);
  if (isNativeJsExceptionName(name)) {
    return {
      ...internalPanicTemplate,
      error_fingerprint: fingerprint("error", name),
    };
  }

  return {
    ...defaultUnknownTemplate,
    error_fingerprint: fingerprint("error", name),
  };
}

export function classifyCliCauseActionability(cause: Cause.Cause<unknown>): CliErrorActionability {
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause));
  return classifyCliErrorActionability(error);
}
