export const CliErrorKind = {
  UserActionable: "user_actionable",
  InternalBug: "internal_bug",
  ExternalService: "external_service",
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
  Panic: "panic",
  ImpossibleState: "impossible_state",
  Unknown: "unknown",
} as const;

export type CliErrorCategory = (typeof CliErrorCategory)[keyof typeof CliErrorCategory];

export const CliSuggestionType = {
  Login: "login",
  LinkProject: "link_project",
  StartDocker: "start_docker",
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

const defaultUnknownTemplate: ActionabilityTemplate = {
  error_kind: CliErrorKind.Unknown,
  error_category: CliErrorCategory.Unknown,
  has_suggestion: false,
  suggestion_type: CliSuggestionType.None,
};

const actionabilityByTag = {
  InvalidTokenError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  LegacyInvalidAccessTokenError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  LegacyLinkAuthTokenError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  LegacyPlatformAuthRequiredError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  PlatformAuthRequiredError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
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
  InvalidProjectLinkStateError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  LegacyInvalidProjectRefError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  LegacyDockerRunError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.DockerNotRunning,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.StartDocker,
  },
  MissingOption: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  NoTtyError: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  UnknownSubcommand: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  UnrecognizedOption: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  DockerPullError: {
    error_kind: CliErrorKind.ExternalService,
    error_category: CliErrorCategory.Network,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
  ApiError: {
    error_kind: CliErrorKind.ExternalService,
    error_category: CliErrorCategory.ApiStatus,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  InvalidStackStateError: {
    error_kind: CliErrorKind.InternalBug,
    error_category: CliErrorCategory.ImpossibleState,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
  StackBuildError: {
    error_kind: CliErrorKind.InternalBug,
    error_category: CliErrorCategory.ImpossibleState,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
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

function fingerprint(prefix: string, identifier: string | undefined): string {
  return identifier === undefined ? `${prefix}:unknown` : `${prefix}:${identifier}`;
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

function inferTemplateFromTag(tag: string | undefined): ActionabilityTemplate | undefined {
  if (tag === undefined) return undefined;
  if (/Panic/.test(tag)) {
    return {
      error_kind: CliErrorKind.InternalBug,
      error_category: CliErrorCategory.Panic,
      has_suggestion: true,
      suggestion_type: CliSuggestionType.RerunDebug,
    };
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

export function classifyCliErrorActionability(error: unknown): CliErrorActionability {
  const tag = readErrorTag(error);
  if (tag === "ShowHelp" && isErrorRecord(error)) {
    const classified = classifyShowHelp(error);
    if (classified !== undefined) return classified;
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

  return {
    ...defaultUnknownTemplate,
    error_fingerprint: fingerprint("error", readErrorName(error)),
  };
}
