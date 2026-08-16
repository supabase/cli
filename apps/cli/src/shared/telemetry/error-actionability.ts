import {
  MANAGED_ERROR_CODES,
  MANAGED_ERROR_TAG_BY_CODE,
  type ManagedErrorCode,
  type UnsupportedGitWorkspaceCause,
} from "@supabase/stack/managed-model";
import { Cause, Option } from "effect";
import type { CliError as EffectCliError } from "effect/unstable/cli";

/**
 * CLI error actionability taxonomy for KPI reporting (CLI-1560).
 *
 * Classification is declared where each error is defined: every error class in
 * `apps/cli/src` exposes a {@link CliErrorActionabilityDeclaration} under the
 * {@link ErrorActionabilityId} symbol (enforced by
 * `error-actionability-coverage.unit.test.ts`). Errors originating outside the
 * CLI workspace (`@supabase/stack`, `@supabase/config`,
 * `@supabase/process-compose`, `effect` cli/http) are classified by the
 * structural adapters at the bottom of this module, which are themselves
 * exhaustiveness-checked against those packages' sources.
 *
 * Everything emitted from here is sanitized by construction: kinds, categories,
 * suggestion types, and fingerprints use closed enums and source-owned
 * identifiers — never raw error text or user-specific data.
 */

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
  ProjectPaused: "project_paused",
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
  RunCommand: "run_command",
  UpgradePlan: "upgrade_plan",
  RerunDebug: "rerun_debug",
  OpenDashboard: "open_dashboard",
  None: "none",
} as const;

export type CliSuggestionType = (typeof CliSuggestionType)[keyof typeof CliSuggestionType];

const CLI_SUGGESTED_COMMANDS = [
  "supabase branches create",
  "supabase link",
  "supabase login",
  "supabase start",
  "supabase stop",
] as const;

type CliSuggestedCommand = (typeof CLI_SUGGESTED_COMMANDS)[number];

const CLI_ERROR_FINGERPRINT_SUFFIXES = [
  "api_response",
  "api_status",
  "asset_checksum",
  "asset_preparation",
  "auth",
  "bad_argument",
  "branch_not_ready",
  "conflict",
  "cancelled",
  "connect",
  "container_configuration",
  "daemon_start",
  "daemon_protocol",
  "daemon_status",
  "daemon_transport",
  "database",
  "docker_not_running",
  "filesystem",
  "forbidden",
  "gateway_auth",
  "image_inspect",
  "invalid_content",
  "invalid_url",
  "internal_build",
  "invalid_config",
  "managed_git_workspace_inside_git_directory",
  "managed_git_workspace_malformed_metadata",
  "managed_git_workspace_metadata_inaccessible",
  "managed_git_workspace_reftable",
  "managed_checkout_conflict",
  "managed_copied_branch_conflict",
  "managed_identity_transition_ownership",
  "managed_inaccessible_path",
  "incompatible_managed_registry",
  "managed_identity",
  "managed_identity_conflict",
  "managed_initialization",
  "managed_operation_in_progress",
  "managed_operation_ownership",
  "managed_owner_pid",
  "managed_pending_update",
  "managed_port",
  "managed_port_change",
  "managed_port_duplicate_key",
  "managed_publication_timeout",
  "managed_recovery",
  "managed_stack_name",
  "managed_stack_not_stopped",
  "network",
  "not_found",
  "plan_limit",
  "platform_error",
  "port_allocation",
  "port_conflict",
  "query",
  "registry_pull",
  "replication_slots_active",
  "replication_slots_query",
  "request_encoding",
  "request_input",
  "saml_disabled",
] as const;

type CliErrorFingerprintSuffix = (typeof CLI_ERROR_FINGERPRINT_SUFFIXES)[number];

type UserActionableErrorCategory =
  | typeof CliErrorCategory.Auth
  | typeof CliErrorCategory.MissingProjectRef
  | typeof CliErrorCategory.ProjectNotLinked
  | typeof CliErrorCategory.DockerNotRunning
  | typeof CliErrorCategory.InvalidConfig
  | typeof CliErrorCategory.DbConnection
  | typeof CliErrorCategory.MigrationDrift
  | typeof CliErrorCategory.Permission
  | typeof CliErrorCategory.PlanLimit
  | typeof CliErrorCategory.ProjectPaused
  | typeof CliErrorCategory.InvalidInput;

type CliErrorKindCategory =
  | {
      readonly error_kind: typeof CliErrorKind.UserActionable;
      readonly error_category: UserActionableErrorCategory;
    }
  | {
      readonly error_kind: typeof CliErrorKind.InternalBug;
      readonly error_category:
        | typeof CliErrorCategory.Panic
        | typeof CliErrorCategory.ImpossibleState;
    }
  | {
      readonly error_kind: typeof CliErrorKind.ExternalService;
      readonly error_category: typeof CliErrorCategory.Network | typeof CliErrorCategory.ApiStatus;
    }
  | {
      readonly error_kind: typeof CliErrorKind.UserCancelled;
      readonly error_category: typeof CliErrorCategory.Cancelled;
    }
  | {
      readonly error_kind: typeof CliErrorKind.Unknown;
      readonly error_category: typeof CliErrorCategory.Unknown;
    };

type CliErrorSuggestion =
  | {
      readonly has_suggestion: false;
      readonly suggestion_type: typeof CliSuggestionType.None;
      readonly suggested_command?: never;
    }
  | {
      readonly has_suggestion: true;
      readonly suggestion_type: typeof CliSuggestionType.Login;
      readonly suggested_command?: "supabase login";
    }
  | {
      readonly has_suggestion: true;
      readonly suggestion_type: typeof CliSuggestionType.LinkProject;
      readonly suggested_command?: "supabase link";
    }
  | {
      readonly has_suggestion: true;
      readonly suggestion_type: typeof CliSuggestionType.RunCommand;
      readonly suggested_command?: "supabase branches create" | "supabase start" | "supabase stop";
    }
  | {
      readonly has_suggestion: true;
      readonly suggestion_type: Exclude<
        CliSuggestionType,
        | typeof CliSuggestionType.None
        | typeof CliSuggestionType.Login
        | typeof CliSuggestionType.LinkProject
        | typeof CliSuggestionType.RunCommand
      >;
      readonly suggested_command?: never;
    };

/** Q2 KPI metric definitions, kept next to the taxonomy they consume. */
export const CliErrorActionabilityMetricDefinitions = {
  strictRecovery: {
    id: "same_command_success_same_session",
    event: "cli_command_executed",
    partition_by: ["device_id", "$session_id", "command"],
    command_identity:
      "Exact equality of the command property, which is the normalized command path emitted by CLI instrumentation without argument values.",
    order_by: "event timestamp ascending",
    eligible_failure: "exit_code != 0 AND error_kind = 'user_actionable'",
    recovered_when:
      "For eligible failure F, there exists event S with S.timestamp > F.timestamp, S.exit_code = 0, and S.device_id = F.device_id, S.$session_id = F.$session_id, and S.command = F.command. Intervening events do not change the result.",
    reset_when:
      "The observation window ends with the $session_id. A success with a different device_id, $session_id, or command never counts.",
    description:
      "A user-actionable failure is recovered only when the same normalized command later succeeds for the same device_id and $session_id.",
  },
  repeatError: {
    id: "same_command_same_error_same_session_before_success",
    event: "cli_command_executed",
    partition_by: ["device_id", "$session_id", "command"],
    command_identity:
      "Exact equality of the command property, which is the normalized command path emitted by CLI instrumentation without argument values.",
    order_by: "event timestamp ascending",
    eligible_failure:
      "exit_code != 0 AND error_kind = 'user_actionable' AND error_fingerprint IS NOT NULL",
    repeated_when:
      "Failed event F is a repeat when an earlier failed event P in the same partition has P.error_fingerprint = F.error_fingerprint and no event S in that partition has P.timestamp < S.timestamp < F.timestamp and S.exit_code = 0.",
    reset_when:
      "Any exit_code = 0 event in the partition clears every prior fingerprint for that command. A different $session_id starts a new partition; successes for other commands do not reset it.",
    description:
      "The second and each later occurrence of the same user-actionable error_fingerprint is a repeat until that normalized command succeeds or the session changes.",
  },
  internalUnknownBugRate: {
    id: "failed_commands_internal_bug_or_unknown",
    event: "cli_command_executed",
    denominator: "count where exit_code != 0 AND error_kind IS NOT NULL",
    numerator: "count where exit_code != 0 AND error_kind IN ('internal_bug', 'unknown')",
    description:
      "Internal/unknown bug failure rate is the share of classified failed commands reported as internal_bug or unknown. Failures without error_kind (pure Go-proxy commands, CLI versions predating the classification) are excluded from both sides; classificationCoverage reports their share.",
  },
  classificationCoverage: {
    id: "failed_commands_with_classification",
    event: "cli_command_executed",
    denominator: "count where exit_code != 0",
    numerator: "count where exit_code != 0 AND error_kind IS NOT NULL",
    description:
      "Share of failed commands carrying the error classification. Pure Go-proxy commands report through the Go binary without these fields, and older CLI versions never send them, so the recovery, repeat, and bug-rate metrics cover exactly this fraction of the failure volume.",
  },
} as const;

/**
 * Symbol under which CLI error classes declare their own actionability.
 * It is intentionally absent from the global symbol registry, so errors from
 * dependencies cannot impersonate a CLI-owned declaration.
 *
 * Declare it as a getter so it lives on the prototype (visible to the coverage
 * test without instantiating the class) and can branch on instance fields:
 *
 * ```ts
 * class MyStatusError extends Data.TaggedError(tag)<{ status: number }> {
 *   get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
 *     return statusCodeActionability(this.status);
 *   }
 * }
 * ```
 */
export const ErrorActionabilityId: unique symbol = Symbol(
  "@supabase/cli/telemetry/ErrorActionability",
);

/** Stable source identifier for CLI-owned plain `Error` subclasses. */
export const ErrorActionabilityFingerprintId: unique symbol = Symbol(
  "@supabase/cli/telemetry/ErrorActionabilityFingerprint",
);

/**
 * Closed metadata declared by each error class. `has_suggestion` describes a
 * canonical remediation; raw instance suggestion text is never inspected.
 */
export type CliErrorActionabilityDeclaration = CliErrorKindCategory &
  CliErrorSuggestion & {
    /**
     * Distinguishes branches of instance-dependent declarations in the repeat
     * fingerprint, so e.g. a registry pull failure and a daemon-down failure of
     * the same wrapper tag never count as repeats of one another. Must be a
     * static safe identifier, never derived from error text.
     */
    readonly fingerprint_suffix?: CliErrorFingerprintSuffix;
  };

/** Sanitized classification emitted with failed `cli_command_executed` events. */
export type CliErrorActionability = CliErrorKindCategory &
  CliErrorSuggestion & {
    readonly error_fingerprint: string;
  };

/** Shared declarations for the recurring classification shapes. */
export const actionability = {
  authLogin: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  authToken: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Auth,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.SetEnvVar,
  },
  provideFlags: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.ProvideFlags,
  },
  invalidInput: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidInput,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  invalidConfig: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpdateConfig,
  },
  /**
   * A database operation failed because of the user's own SQL, schema, or
   * data — actionable, but the CLI has no generic remediation to suggest.
   */
  dbFinding: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  dbConnection: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.DbConnection,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpdateConfig,
  },
  migrationDrift: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.MigrationDrift,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RepairMigration,
  },
  permission: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Permission,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  accountAccess: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.Permission,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.Login,
    suggested_command: "supabase login",
  },
  planLimit: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.PlanLimit,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpgradePlan,
  },
  projectNotLinked: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.ProjectNotLinked,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  missingProjectRef: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.MissingProjectRef,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  /** Local link state exists but is unusable — re-linking repairs it. */
  relinkProject: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.LinkProject,
    suggested_command: "supabase link",
  },
  dockerNotRunning: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.DockerNotRunning,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.StartDocker,
  },
  startStack: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RunCommand,
    suggested_command: "supabase start",
  },
  stopStack: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RunCommand,
    suggested_command: "supabase stop",
  },
  externalNetwork: {
    error_kind: CliErrorKind.ExternalService,
    error_category: CliErrorCategory.Network,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
  apiStatus: {
    error_kind: CliErrorKind.ExternalService,
    error_category: CliErrorCategory.ApiStatus,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  cancelled: {
    error_kind: CliErrorKind.UserCancelled,
    error_category: CliErrorCategory.Cancelled,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
  internalPanic: {
    error_kind: CliErrorKind.InternalBug,
    error_category: CliErrorCategory.Panic,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
  impossibleState: {
    error_kind: CliErrorKind.InternalBug,
    error_category: CliErrorCategory.ImpossibleState,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.RerunDebug,
  },
  unknown: {
    error_kind: CliErrorKind.Unknown,
    error_category: CliErrorCategory.Unknown,
    has_suggestion: false,
    suggestion_type: CliSuggestionType.None,
  },
} as const satisfies Record<string, CliErrorActionabilityDeclaration>;

/**
 * The declaration for a failure confirmed plan-gated by the entitlement
 * check (`legacySuggestUpgrade`). Shared so every gated surface groups under
 * the same fingerprint family.
 */
export const planLimitGatedActionability: CliErrorActionabilityDeclaration = {
  ...actionability.planLimit,
  fingerprint_suffix: "plan_limit",
};

/**
 * Classification policy for errors that carry a Management API status code.
 * `upgradeSuggested` is the typed result of the entitlement gate
 * (`legacySuggestUpgrade`) threaded through the error constructor — never
 * inferred from message text.
 *
 * A 404 is user-actionable only when the caller knows the endpoint names a
 * user-selected resource. List and discovery endpoints can also return 404,
 * so the default remains an API-status failure. The entitlement-gate branch
 * stays ahead of that opt-in so a confirmed plan-limited 404 still classifies
 * as `plan_limit`.
 */
export function statusCodeActionability(
  status: number | undefined,
  opts: {
    readonly upgradeSuggested?: boolean;
    readonly notFoundIsInvalidInput?: boolean;
  } = {},
): CliErrorActionabilityDeclaration {
  if (status === 401) {
    return { ...actionability.authLogin, fingerprint_suffix: "auth" };
  }
  if (opts.upgradeSuggested === true && status !== undefined && status >= 400 && status < 500) {
    return planLimitGatedActionability;
  }
  if (status === 403) {
    return { ...actionability.accountAccess, fingerprint_suffix: "forbidden" };
  }
  if (status === 404 && opts.notFoundIsInvalidInput === true) {
    return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
  }
  if (status === undefined) {
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  }
  return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
}

type ErrorRecord = Record<PropertyKey, unknown>;

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

const suggestedCommandValues = new Set<string>(CLI_SUGGESTED_COMMANDS);
const fingerprintSuffixValues = new Set<string>(CLI_ERROR_FINGERPRINT_SUFFIXES);

function isUserActionableCategory(value: unknown): value is UserActionableErrorCategory {
  return (
    value === CliErrorCategory.Auth ||
    value === CliErrorCategory.MissingProjectRef ||
    value === CliErrorCategory.ProjectNotLinked ||
    value === CliErrorCategory.DockerNotRunning ||
    value === CliErrorCategory.InvalidConfig ||
    value === CliErrorCategory.DbConnection ||
    value === CliErrorCategory.MigrationDrift ||
    value === CliErrorCategory.Permission ||
    value === CliErrorCategory.PlanLimit ||
    value === CliErrorCategory.ProjectPaused ||
    value === CliErrorCategory.InvalidInput
  );
}

function sanitizeKindCategory(kind: unknown, category: unknown): CliErrorKindCategory | undefined {
  if (kind === CliErrorKind.UserActionable && isUserActionableCategory(category)) {
    return { error_kind: kind, error_category: category };
  }
  if (
    kind === CliErrorKind.InternalBug &&
    (category === CliErrorCategory.Panic || category === CliErrorCategory.ImpossibleState)
  ) {
    return { error_kind: kind, error_category: category };
  }
  if (
    kind === CliErrorKind.ExternalService &&
    (category === CliErrorCategory.Network || category === CliErrorCategory.ApiStatus)
  ) {
    return { error_kind: kind, error_category: category };
  }
  if (kind === CliErrorKind.UserCancelled && category === CliErrorCategory.Cancelled) {
    return { error_kind: kind, error_category: category };
  }
  if (kind === CliErrorKind.Unknown && category === CliErrorCategory.Unknown) {
    return { error_kind: kind, error_category: category };
  }
  return undefined;
}

function isSuggestionWithRemediation(
  value: unknown,
): value is Exclude<CliSuggestionType, typeof CliSuggestionType.None> {
  return (
    value === CliSuggestionType.Login ||
    value === CliSuggestionType.LinkProject ||
    value === CliSuggestionType.StartDocker ||
    value === CliSuggestionType.ProvideFlags ||
    value === CliSuggestionType.SetEnvVar ||
    value === CliSuggestionType.RepairMigration ||
    value === CliSuggestionType.UpdateConfig ||
    value === CliSuggestionType.RunCommand ||
    value === CliSuggestionType.UpgradePlan ||
    value === CliSuggestionType.RerunDebug ||
    value === CliSuggestionType.OpenDashboard
  );
}

function isSuggestedCommand(value: unknown): value is CliSuggestedCommand {
  return typeof value === "string" && suggestedCommandValues.has(value);
}

function sanitizeSuggestion(
  hasSuggestion: unknown,
  suggestionType: unknown,
  suggestedCommand: unknown,
): CliErrorSuggestion | undefined {
  if (
    hasSuggestion === false &&
    suggestionType === CliSuggestionType.None &&
    suggestedCommand === undefined
  ) {
    return { has_suggestion: false, suggestion_type: suggestionType };
  }
  if (hasSuggestion !== true || !isSuggestionWithRemediation(suggestionType)) {
    return undefined;
  }
  if (suggestedCommand === undefined) {
    return { has_suggestion: true, suggestion_type: suggestionType };
  }
  if (!isSuggestedCommand(suggestedCommand)) return undefined;
  if (suggestionType === CliSuggestionType.Login && suggestedCommand === "supabase login") {
    return {
      has_suggestion: true,
      suggestion_type: suggestionType,
      suggested_command: suggestedCommand,
    };
  }
  if (suggestionType === CliSuggestionType.LinkProject && suggestedCommand === "supabase link") {
    return {
      has_suggestion: true,
      suggestion_type: suggestionType,
      suggested_command: suggestedCommand,
    };
  }
  if (
    suggestionType === CliSuggestionType.RunCommand &&
    (suggestedCommand === "supabase branches create" ||
      suggestedCommand === "supabase start" ||
      suggestedCommand === "supabase stop")
  ) {
    return {
      has_suggestion: true,
      suggestion_type: suggestionType,
      suggested_command: suggestedCommand,
    };
  }
  return undefined;
}

function isFingerprintSuffix(value: unknown): value is CliErrorFingerprintSuffix {
  return typeof value === "string" && fingerprintSuffixValues.has(value);
}

function sanitizeDeclaration(value: unknown): CliErrorActionabilityDeclaration | undefined {
  if (!isErrorRecord(value)) return undefined;
  const kindCategory = sanitizeKindCategory(value["error_kind"], value["error_category"]);
  if (kindCategory === undefined) return undefined;
  const suggestion = sanitizeSuggestion(
    value["has_suggestion"],
    value["suggestion_type"],
    value["suggested_command"],
  );
  if (suggestion === undefined) return undefined;
  const fingerprintSuffix = value["fingerprint_suffix"];
  if (fingerprintSuffix === undefined) return { ...kindCategory, ...suggestion };
  if (!isFingerprintSuffix(fingerprintSuffix)) return undefined;
  return { ...kindCategory, ...suggestion, fingerprint_suffix: fingerprintSuffix };
}

function readDeclaration(error: unknown): CliErrorActionabilityDeclaration | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(error);
    if (!isErrorRecord(prototype)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, ErrorActionabilityId);
    if (descriptor?.get === undefined) return undefined;
    return sanitizeDeclaration(Reflect.apply(descriptor.get, error, []));
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // The length cap is defense-in-depth: every legitimate identifier is a
  // class/tag name, so an oversized value is never a real CLI error source.
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : undefined;
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

function readDeclaredErrorFingerprintId(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const prototype = Object.getPrototypeOf(error);
  if (!isErrorRecord(prototype)) return undefined;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (constructorDescriptor === undefined || !("value" in constructorDescriptor)) return undefined;
  const constructor = constructorDescriptor.value;
  if (typeof constructor !== "function") return undefined;
  const identifierDescriptor = Object.getOwnPropertyDescriptor(
    constructor,
    ErrorActionabilityFingerprintId,
  );
  if (identifierDescriptor === undefined || !("value" in identifierDescriptor)) return undefined;
  return typeof identifierDescriptor.value === "string"
    ? safeIdentifier(identifierDescriptor.value)
    : undefined;
}

/**
 * `Data.TaggedError` stores its literal tag as an own data property named
 * `name` on a base prototype. Unlike `constructor.name`, that value survives
 * identifier minification. Never invoke prototype getters here: only the
 * static data property created by Effect is a safe fingerprint authority.
 */
function readStableTaggedPrototypeName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  let prototype: unknown = Object.getPrototypeOf(error);
  while (prototype !== Error.prototype) {
    if (!isErrorRecord(prototype)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "name");
    if (descriptor !== undefined && "value" in descriptor) {
      const name =
        typeof descriptor.value === "string" ? safeIdentifier(descriptor.value) : undefined;
      if (name !== undefined && name !== "Error") return name;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function fingerprint(
  prefix: "error" | "string" | "tag",
  identifier: string | undefined,
  suffix?: CliErrorFingerprintSuffix,
): string {
  const base = identifier === undefined ? `${prefix}:unknown` : `${prefix}:${identifier}`;
  return suffix === undefined ? base : `${base}:${suffix}`;
}

function toActionability(
  declaration: CliErrorActionabilityDeclaration,
  fingerprintPrefix: "error" | "string" | "tag",
  identifier: string | undefined,
): CliErrorActionability {
  const { fingerprint_suffix, ...metadata } = declaration;
  return {
    ...metadata,
    error_fingerprint: fingerprint(fingerprintPrefix, identifier, fingerprint_suffix),
  };
}

/**
 * Adapters for errors defined outside `apps/cli`, keyed by `_tag`. Kept
 * exhaustive against those packages' sources by
 * `error-actionability-coverage.unit.test.ts`. Everything defined inside
 * `apps/cli` must declare {@link ErrorActionabilityId} instead of being
 * added here.
 */
type ErrorActionabilityAdapter = (error: ErrorRecord) => CliErrorActionabilityDeclaration;

type EffectCliAdapterTag = Exclude<EffectCliError.CliError["_tag"], "ShowHelp" | "UserError">;

// ShowHelp and UserError recurse in classifyCliErrorActionability. This map is
// typed against Effect's complete parser-error union so dependency upgrades
// cannot silently add an unclassified parser failure.
const effectCliActionabilityByTag = {
  MissingOption: () => actionability.invalidInput,
  MissingArgument: () => actionability.invalidInput,
  DuplicateOption: () => actionability.invalidInput,
  UnexpectedArgument: () => actionability.invalidInput,
  InvalidValue: () => actionability.invalidInput,
  // Effect 4.0.0-beta.103 has this typo in the runtime tag. Keep the adapter
  // keyed to reality; the emitted fingerprint is normalized below.
  UnknownSubcomand: () => actionability.invalidInput,
  UnrecognizedOption: () => actionability.invalidInput,
} satisfies Record<EffectCliAdapterTag, ErrorActionabilityAdapter>;

/**
 * The materially different reasons {@link UnsupportedGitWorkspaceCause} names,
 * projected onto a distinct closed fingerprint suffix each — so a refusal
 * because the CLI ran inside git metadata, a malformed-metadata refusal, and a
 * reftable refusal never group together as repeats of one another.
 */
const UNSUPPORTED_GIT_WORKSPACE_FINGERPRINT_SUFFIX_BY_CAUSE: Record<
  UnsupportedGitWorkspaceCause,
  CliErrorFingerprintSuffix
> = {
  "inside-git-directory": "managed_git_workspace_inside_git_directory",
  "malformed-metadata": "managed_git_workspace_malformed_metadata",
  "metadata-inaccessible": "managed_git_workspace_metadata_inaccessible",
  reftable: "managed_git_workspace_reftable",
};

function isUnsupportedGitWorkspaceCause(value: string): value is UnsupportedGitWorkspaceCause {
  return (
    value === "inside-git-directory" ||
    value === "malformed-metadata" ||
    value === "metadata-inaccessible" ||
    value === "reftable"
  );
}

/** Branches on the error's own typed `workspaceCause` field, never on reason text. */
function unsupportedGitWorkspaceFingerprintSuffix(error: ErrorRecord): CliErrorFingerprintSuffix {
  const cause = readString(error, "workspaceCause");
  return cause !== undefined && isUnsupportedGitWorkspaceCause(cause)
    ? UNSUPPORTED_GIT_WORKSPACE_FINGERPRINT_SUFFIX_BY_CAUSE[cause]
    : "managed_git_workspace_malformed_metadata";
}

/**
 * `@supabase/stack` managed registry failures, keyed by the stable `code`
 * literal each class declares. `code` is the package's wire-level contract: it
 * survives the identifier minification of release builds, and Node/Bun callers
 * outside an Effect runtime branch on it. Dispatch, however, goes through
 * `_tag` like every other external error — {@link managedActionabilityByTag}
 * projects this table onto the tags via the package's own tag/code map.
 *
 * Keyed by the package's exported {@link ManagedErrorCode} union, so the table
 * is exhaustive by construction: a new managed failure cannot be added in
 * `@supabase/stack` without being classified here. Values are adapters (not
 * bare declarations) so an entry — like `UNSUPPORTED_GIT_WORKSPACE` below — can
 * branch on the raised instance's own fields.
 */
const managedActionabilityByCode: Record<ManagedErrorCode, ErrorActionabilityAdapter> = {
  INVALID_MANAGED_IDENTITY: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_identity",
  }),
  DUPLICATE_MANAGED_IDENTITY: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "managed_identity_conflict",
  }),
  MANAGED_INVALID_STACK_NAME: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_stack_name",
  }),
  MANAGED_CHECKOUT_CONFLICT: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_checkout_conflict",
  }),
  MANAGED_COPIED_BRANCH_CONFLICT: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "managed_copied_branch_conflict",
  }),
  MANAGED_IDENTITY_TRANSITION_OWNERSHIP: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_identity_transition_ownership",
  }),
  MANAGED_INACCESSIBLE_PATH: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_inaccessible_path",
  }),
  INCOMPATIBLE_MANAGED_REGISTRY: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "incompatible_managed_registry",
  }),
  MANAGED_STACK_NOT_FOUND: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "not_found",
  }),
  // The directory the command ran in holds git metadata rather than a working
  // tree — a bare repository or a `.git` — so the remediation is to run it from a
  // checkout instead. The suffix is split by the error's own `workspaceCause` field: see
  // unsupportedGitWorkspaceFingerprintSuffix.
  UNSUPPORTED_GIT_WORKSPACE: (error) => ({
    ...actionability.invalidInput,
    fingerprint_suffix: unsupportedGitWorkspaceFingerprintSuffix(error),
  }),
  // Another caller owns the stack right now; the remediation is to settle that
  // operation before retrying.
  MANAGED_OPERATION_IN_PROGRESS: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_operation_in_progress",
  }),
  MANAGED_OPERATION_OWNERSHIP_MISMATCH: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_operation_ownership",
  }),
  MANAGED_STACK_PUBLICATION_TIMEOUT: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_publication_timeout",
  }),
  MANAGED_OPERATION_REQUIRES_RECONCILIATION: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_recovery",
  }),
  MANAGED_STACK_NOT_STOPPED: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_stack_not_stopped",
  }),
  MANAGED_RUNNING_STACK_PORT_CHANGE: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_port_change",
  }),
  // The operation owner pid comes from the CLI process itself, never from user
  // input, so a rejected pid is a broken internal invariant.
  MANAGED_INVALID_OWNER_PID: () => ({
    ...actionability.impossibleState,
    fingerprint_suffix: "managed_owner_pid",
  }),
  // Only internal misuse of the repository can call `updateStack` on a still
  // unpublished (pending) row; nothing a user does reaches this.
  MANAGED_PENDING_STACK_UPDATE: () => ({
    ...actionability.impossibleState,
    fingerprint_suffix: "managed_pending_update",
  }),
  MANAGED_PORT_ALREADY_RESERVED: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_conflict",
  }),
  LEGACY_SOURCE_RUNNING: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "port_conflict",
  }),
  MANAGED_EXACT_PORT_OCCUPIED: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_conflict",
  }),
  MANAGED_STICKY_PORT_OCCUPIED: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_conflict",
  }),
  MANAGED_PORT_CLAIM_RACE: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "port_conflict",
  }),
  MANAGED_PORT_ALLOCATION_FAILED: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "port_allocation",
  }),
  MANAGED_RUNTIME_START_FAILED: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "managed_initialization",
  }),
  // The port number itself is unusable (fractional or outside 1-65535), which
  // is the user's own configured value rather than a conflict with a peer.
  MANAGED_INVALID_PORT: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "managed_port",
  }),
  // Two of the user's own port assignments name the same key, which is the
  // user's configured value rather than a conflict with another stack.
  MANAGED_DUPLICATE_PORT_KEY: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "managed_port_duplicate_key",
  }),
  // The registry derives every stack root itself, so a path that fails the
  // containment check means the CLI passed a rejected argument.
  UNSAFE_MANAGED_STACK_PATH: () => ({
    ...actionability.impossibleState,
    fingerprint_suffix: "bad_argument",
  }),
  MANAGED_STACK_INITIALIZATION_FAILED: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "managed_initialization",
  }),
};

/**
 * The managed table above, re-keyed by the `_tag` of the class that declares
 * each code. Generated from `@supabase/stack`'s own tag/code map so every
 * managed tag is classified without restating a single verdict:
 * {@link managedActionabilityByCode} stays the one place a managed failure is
 * classified, and a tag/code pair the package renames cannot silently fall
 * through to `unknown`.
 */
const managedActionabilityByTag: Record<string, ErrorActionabilityAdapter> = Object.fromEntries(
  MANAGED_ERROR_CODES.map((code) => [
    MANAGED_ERROR_TAG_BY_CODE[code],
    managedActionabilityByCode[code],
  ]),
);

/**
 * Whether a `@supabase/stack` managed error code has a classification in
 * {@link managedActionabilityByCode}. Used by the coverage test to keep the
 * table exhaustive against the managed classes; the tags themselves are checked
 * through {@link isClassifiedExternalErrorTag}, which the generated entries
 * satisfy.
 */
export function isClassifiedManagedErrorCode(code: string): boolean {
  return Object.hasOwn(managedActionabilityByCode, code);
}

const externalActionabilityByTag: Record<string, ErrorActionabilityAdapter> = {
  ...effectCliActionabilityByTag,
  ...managedActionabilityByTag,

  // effect PlatformError — OS/filesystem operations. `reason` is
  // `BadArgument | SystemError`; BadArgument means the CLI itself passed a
  // rejected argument (internal bug). Only the closed PermissionDenied and
  // NotFound reasons have context-independent user-actionable meanings.
  PlatformError: (error) => {
    const reason = error["reason"];
    const reasonTag = isErrorRecord(reason)
      ? safeIdentifier(readString(reason, "_tag"))
      : undefined;
    if (reasonTag === "BadArgument") {
      return { ...actionability.impossibleState, fingerprint_suffix: "bad_argument" };
    }
    if (reasonTag === "PermissionDenied") {
      return { ...actionability.permission, fingerprint_suffix: "filesystem" };
    }
    if (reasonTag === "NotFound") {
      return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
    }
    // The remaining closed SystemError reasons are context-dependent. Keep
    // them unknown until a command boundary supplies a more specific wrapper
    // instead of misreporting every local I/O failure as a permission issue.
    return { ...actionability.unknown, fingerprint_suffix: "platform_error" };
  },
  BadArgument: () => ({ ...actionability.impossibleState, fingerprint_suffix: "bad_argument" }),

  // @supabase/config
  ProjectConfigParseError: () => actionability.invalidConfig,
  ProjectEnvParseError: () => actionability.invalidConfig,
  MissingProjectConfigValueError: () => actionability.invalidConfig,
  DuplicateRemoteProjectIdError: () => actionability.invalidConfig,
  InvalidRemoteProjectIdError: () => actionability.invalidConfig,

  // @supabase/api — client construction failed before any request (missing
  // access token / bad configuration); remediation is the token env var.
  SupabaseApiConfigError: () => actionability.authToken,

  // @supabase/api — the generated client's input schema rejected a request
  // before it was sent. Treat it as an internal request-construction failure
  // unless the command boundary explicitly marked the whole request as
  // user-derived; never infer provenance from the schema error message.
  SupabaseApiInputError: (error) =>
    readString(error, "source") === "user_input"
      ? { ...actionability.invalidInput, fingerprint_suffix: "request_input" }
      : { ...actionability.impossibleState, fingerprint_suffix: "request_encoding" },

  // effect/unstable/http — generated Management API client transport/decoding
  HttpClientError: (error) => {
    const reason = error["reason"];
    const reasonTag = isErrorRecord(reason) ? readString(reason, "_tag") : undefined;
    const response = error["response"];
    const status = isErrorRecord(response) ? readNumber(response, "status") : undefined;
    if (reasonTag === "DecodeError" || reasonTag === "EmptyBodyError") {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    if (status === 401) return { ...actionability.authLogin, fingerprint_suffix: "auth" };
    if (status === 403) return { ...actionability.accountAccess, fingerprint_suffix: "forbidden" };
    if (reasonTag === "StatusCodeError" || isErrorRecord(response)) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
    }
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  },
  // Request-body construction failed before the HTTP request was sent. The
  // generated client owns this encoding boundary, so it is an impossible
  // state rather than an API-response failure.
  HttpBodyError: () => ({
    ...actionability.impossibleState,
    fingerprint_suffix: "request_encoding",
  }),
  SchemaError: () => ({ ...actionability.apiStatus, fingerprint_suffix: "api_response" }),

  // @supabase/stack — StackError is a plain Error subclass matched by `name`
  // in classifyCliErrorActionability, with a structured `code` field.
  StackError: (error) =>
    readString(error, "code") === "PORT_ALLOCATION"
      ? { ...actionability.invalidConfig, fingerprint_suffix: "port_allocation" }
      : actionability.unknown,
  BinaryNotFoundError: () => actionability.invalidConfig,
  DownloadError: () => actionability.externalNetwork,
  ChecksumMismatchError: () => ({
    ...actionability.externalNetwork,
    fingerprint_suffix: "asset_checksum",
  }),
  DockerPullError: (error) =>
    error["daemonDown"] === true
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" },
  StackBuildError: (error) => {
    const reason = readString(error, "reason");
    if (reason === "invalid_config") {
      return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
    }
    if (reason === "docker_not_running") {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    if (reason === "asset_preparation") {
      return { ...actionability.externalNetwork, fingerprint_suffix: "asset_preparation" };
    }
    return { ...actionability.impossibleState, fingerprint_suffix: "internal_build" };
  },
  PortConflictError: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_conflict",
  }),
  PortAllocationError: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_allocation",
  }),
  StateNotFoundError: () => actionability.startStack,
  StateClaimError: (error) =>
    readString(error, "reason") === "already-claimed"
      ? { ...actionability.stopStack, fingerprint_suffix: "conflict" }
      : { ...actionability.permission, fingerprint_suffix: "filesystem" },
  StackNotRunningError: () => actionability.startStack,
  StackReadinessError: () => actionability.startStack,
  StackMetadataNotFoundError: () => actionability.startStack,
  InvalidStackStateError: () => actionability.invalidConfig,
  InvalidStackMetadataError: () => actionability.invalidConfig,
  UnsupportedStackMetadataVersionError: () => actionability.invalidConfig,
  NoRunningStackError: () => actionability.startStack,
  StackAlreadyRunningError: () => actionability.stopStack,
  DaemonStartError: () => actionability.unknown,
  ManagedDaemonStartError: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "daemon_start",
  }),
  DaemonStillRunningError: () => actionability.stopStack,
  // Transport failures retain the existing stack-recovery policy. An HTTP
  // status or protocol failure came from the CLI-owned daemon itself and is
  // therefore an internal invariant failure, not user configuration.
  UnixHttpClientError: (error) => {
    const reason = readString(error, "reason");
    if (reason === "protocol") {
      return { ...actionability.impossibleState, fingerprint_suffix: "daemon_protocol" };
    }
    if (reason === "status") {
      return { ...actionability.impossibleState, fingerprint_suffix: "daemon_status" };
    }
    if (reason !== "transport") return actionability.unknown;
    const path = readString(error, "path");
    if (path !== undefined && path.startsWith("/start")) {
      return { ...actionability.startStack, fingerprint_suffix: "daemon_start" };
    }
    return { ...actionability.stopStack, fingerprint_suffix: "daemon_transport" };
  },

  // @supabase/process-compose — the CLI generates the process graph, so graph
  // invariants are internal bugs; runtime service failures are stack-state
  // problems the user resolves by restarting the stack.
  CyclicDependencyError: () => actionability.impossibleState,
  MissingDependencyError: () => actionability.impossibleState,
  ServiceNotFoundError: () => actionability.impossibleState,
  SpawnError: () => actionability.startStack,
  ShutdownTimeoutError: () => actionability.stopStack,
  ServiceReadyError: () => actionability.startStack,
};

/**
 * Whether a tag defined outside `apps/cli` has an external adapter. Used by
 * the coverage test to keep {@link externalActionabilityByTag} exhaustive
 * against the workspace packages.
 */
export function isClassifiedExternalErrorTag(tag: string): boolean {
  return Object.hasOwn(externalActionabilityByTag, tag);
}

/**
 * A wrapper's preserved `cause`, but only when classifying it cannot degrade
 * the result: the cause must carry its own declaration or a known external
 * adapter tag, otherwise the wrapper's own classification is more truthful.
 */
function classifiableCause(error: ErrorRecord): ErrorRecord | undefined {
  const cause = error["cause"];
  if (!isErrorRecord(cause)) return undefined;
  if (readDeclaration(cause) !== undefined) return cause;
  const causeTag = readErrorTag(cause);
  if (causeTag !== undefined && Object.hasOwn(externalActionabilityByTag, causeTag)) return cause;
  return undefined;
}

function classifyShowHelp(error: ErrorRecord, depth: number): CliErrorActionability | undefined {
  const errors = error["errors"];
  if (!Array.isArray(errors)) return undefined;
  if (errors.length === 1) return classifyAtDepth(errors[0], depth + 1);
  return toActionability(actionability.invalidInput, "tag", "ShowHelp");
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

/**
 * Hard cap on cause-chain recursion (ShowHelp, UserError, and stack wrapper
 * causes). Real chains are 1-2 deep; the cap exists so a cyclic or
 * adversarial cause chain can never stack-overflow the failure-telemetry
 * path itself.
 */
const MAX_CAUSE_DEPTH = 8;

export function classifyCliErrorActionability(error: unknown): CliErrorActionability {
  try {
    return classifyAtDepth(error, 0);
  } catch {
    return toActionability(actionability.unknown, "error", "ClassificationFailure");
  }
}

function classifyAtDepth(error: unknown, depth: number): CliErrorActionability {
  if (depth >= MAX_CAUSE_DEPTH) {
    return toActionability(actionability.unknown, "error", "CauseChainLimit");
  }
  const declared = readDeclaration(error);
  if (declared !== undefined) {
    const stableTaggedName = readStableTaggedPrototypeName(error);
    const tag = readErrorTag(error);
    if (stableTaggedName !== undefined && tag === stableTaggedName) {
      return toActionability(declared, "tag", tag);
    }
    // The declared static identifier outranks the prototype walk: a class
    // extending a native Error subtype (e.g. `extends TypeError`) would
    // otherwise pick up the native prototype's own `name` and collide on it.
    return toActionability(
      declared,
      "error",
      readDeclaredErrorFingerprintId(error) ?? stableTaggedName ?? "DeclaredError",
    );
  }

  const tag = readErrorTag(error);

  if (tag === "ShowHelp" && isErrorRecord(error)) {
    const classified = classifyShowHelp(error, depth);
    if (classified !== undefined) return classified;
  }

  // effect cli wraps handler failures in UserError({ cause }) — classify the
  // actual failure instead of the wrapper.
  if (tag === "UserError" && isErrorRecord(error) && error["cause"] !== undefined) {
    return classifyAtDepth(error["cause"], depth + 1);
  }

  // @supabase/stack wrapper errors preserve the underlying tagged failure in
  // `cause`; classify it when it is more specific than the wrapper (e.g. a
  // daemon-down DockerPullError inside an asset-preparation StackBuildError,
  // or a user's ProjectConfigParseError inside a reason-less StackBuildError).
  // Explicit `invalid_config` StackBuildErrors are deliberate user-facing
  // config verdicts and are never overridden by their cause.
  if (
    isErrorRecord(error) &&
    tag === "StackBuildError" &&
    readString(error, "reason") !== "invalid_config"
  ) {
    const cause = classifiableCause(error);
    if (cause !== undefined) {
      return classifyAtDepth(cause, depth + 1);
    }
  }

  // DownloadError recurses ONLY into local filesystem causes (PlatformError:
  // unwritable cache, extraction failure). HTTP causes stay on the wrapper —
  // the HttpClientError adapter's 401/403 → auth/permission policy is
  // Management-API-specific and must not apply to GitHub/CDN asset downloads.
  if (isErrorRecord(error) && tag === "DownloadError") {
    const cause = error["cause"];
    if (isErrorRecord(cause) && readErrorTag(cause) === "PlatformError") {
      return classifyAtDepth(cause, depth + 1);
    }
  }

  // ManagedStackInitializationError is only a wrapper: the real provisioning
  // failure (a Docker pull, a config parse, ...) is preserved in `cause`, and
  // the generic initialization verdict would hide the actionable one.
  if (isErrorRecord(error) && tag === "ManagedStackInitializationError") {
    const cause = classifiableCause(error);
    if (cause !== undefined) return classifyAtDepth(cause, depth + 1);
  }

  if (tag !== undefined && isErrorRecord(error)) {
    // Own-property lookup: a sanitized tag like "constructor" must not pick
    // up Object.prototype members as adapters.
    if (Object.hasOwn(externalActionabilityByTag, tag)) {
      const external = externalActionabilityByTag[tag];
      if (external !== undefined) {
        const fingerprintTag = tag === "UnknownSubcomand" ? "UnknownSubcommand" : tag;
        return toActionability(external(error), "tag", fingerprintTag);
      }
    }
    return toActionability(actionability.unknown, "tag", undefined);
  }

  if (isErrorRecord(error) && readErrorName(error) === "StackError") {
    // The public Stack promise API wraps tagged failures via `toStackError`,
    // preserving the original in `cause` — classify that instead of the
    // wrapper whenever it is itself classifiable.
    const cause = classifiableCause(error);
    if (cause !== undefined) {
      return classifyAtDepth(cause, depth + 1);
    }
    // toStackError wraps arbitrary thrown errors with code "UNKNOWN"; a
    // native JS exception cause is a stack-internal crash and must land in
    // the internal-bug bucket, matching the top-level native-exception rule.
    if (isNativeJsExceptionName(readErrorName(error["cause"]))) {
      return classifyAtDepth(error["cause"], depth + 1);
    }
    const classify = externalActionabilityByTag["StackError"];
    if (classify !== undefined) {
      return toActionability(classify(error), "error", "StackError");
    }
  }

  if (typeof error === "string") {
    return toActionability(actionability.unknown, "string", undefined);
  }

  const name = readErrorName(error);
  if (isNativeJsExceptionName(name)) {
    return toActionability(actionability.internalPanic, "error", name);
  }

  return toActionability(actionability.unknown, "error", undefined);
}

export function classifyCliCauseActionability(cause: Cause.Cause<unknown>): CliErrorActionability {
  let firstKnownDefect: CliErrorActionability | undefined;
  let hasUnknownDefect = false;
  for (const reason of cause.reasons) {
    if (!Cause.isDieReason(reason)) continue;
    const classified = classifyCliErrorActionability(reason.defect);
    if (classified.error_kind === CliErrorKind.InternalBug) return classified;
    if (classified.error_kind === CliErrorKind.Unknown) hasUnknownDefect = true;
    else firstKnownDefect ??= classified;
  }
  if (hasUnknownDefect) return toActionability(actionability.internalPanic, "error", "Defect");
  if (firstKnownDefect !== undefined) return firstKnownDefect;
  if (Cause.hasInterruptsOnly(cause)) {
    return toActionability(actionability.cancelled, "error", "Interrupt");
  }
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause));
  return classifyCliErrorActionability(error);
}

/**
 * Fallback for a command that deliberately signalled failure through
 * ProcessControl without failing its Effect, when no typed error is available
 * to derive a classification from (see `withLegacyCommandInstrumentation`,
 * which classifies the command's own fail-on error class where one exists).
 */
export const unknownProcessControlledFailureActionability: CliErrorActionability = toActionability(
  actionability.unknown,
  "error",
  "ProcessControlledFailure",
);
