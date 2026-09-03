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
 * `effect` cli/http) are classified by the
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
  "daemon_upgrade_required",
  "daemon_upgrade_preflight",
  "daemon_upgrade_restart",
  "daemon_stop_timeout",
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
  "managed_control_ownership",
  "managed_control_bind",
  "managed_control_transport",
  "managed_control_protocol",
  "managed_control_address_conflict",
  "managed_control_stop_conflict",
  "managed_control_maintenance_busy",
  "managed_document",
  "managed_control_required",
  "managed_attached",
  "managed_workspace_repair",
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
  UnknownSubcommand: () => actionability.invalidInput,
  UnrecognizedOption: () => actionability.invalidInput,
} satisfies Record<EffectCliAdapterTag, ErrorActionabilityAdapter>;

const externalActionabilityByTag: Record<string, ErrorActionabilityAdapter> = {
  ...effectCliActionabilityByTag,

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
  CliConfigParseError: () => actionability.invalidConfig,
  CliProjectEnvParseError: () => actionability.invalidConfig,
  DuplicateRemoteProjectIdError: () => actionability.invalidConfig,
  InvalidRemoteProjectIdError: () => actionability.invalidConfig,
  // A Management API project-config response that fails to map is a platform
  // response problem, not a local config-file mistake — the user can't fix
  // the payload by editing supabase/config.toml. `@supabase/config` now
  // builds a real `suggestion` (upgrade the CLI, then report it) on every
  // construction site, so `has_suggestion` flips to true here to match —
  // `RerunDebug` is the closest existing bucket (same idiom as
  // `internalPanic`/`impossibleState` below), there being no dedicated
  // "upgrade the CLI" suggestion type in the closed vocabulary. The
  // `caller_misuse` reason (a `toProjectConfig`/`attachApiResponse` argument
  // error — the producer's typed field, never message text) is a programming
  // error, not an external platform failure: bucketing it as `api_status`
  // would corrupt the external-failure KPI with caller bugs.
  ProjectConfigParseError: (error) =>
    error.reason === "caller_misuse"
      ? { ...actionability.invalidInput, fingerprint_suffix: "request_input" }
      : {
          ...actionability.apiStatus,
          has_suggestion: true,
          suggestion_type: CliSuggestionType.RerunDebug,
          fingerprint_suffix: "api_response",
        },

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

  InvalidStackIdentityError: () => actionability.invalidInput,
  InvalidProjectRootError: () => actionability.invalidInput,
  InvalidStackConfigError: () => actionability.invalidConfig,
  StackVersionUnsupportedError: () => actionability.invalidConfig,
  StackNotFoundError: () => actionability.invalidInput,
  StackOwnershipConflictError: () => actionability.invalidInput,
  StackRuntimeMismatchError: () => actionability.invalidConfig,
  StackMustBeStoppedError: () => actionability.stopStack,
  StackLifecycleConflictError: () => actionability.startStack,
  StackStateInvalidError: () => actionability.invalidConfig,
  StackStateFormatUnsupportedError: () => actionability.invalidConfig,
  StackUpgradeRequiredError: () => actionability.startStack,
  StackSecretMismatchError: () => actionability.invalidConfig,
  InvalidJwtSigningMaterialError: () => actionability.invalidConfig,
  PortUnavailableError: () => actionability.invalidConfig,
  GatewayActivationError: () => actionability.startStack,
  StackPreparationError: () => actionability.startStack,
  ArtifactIntegrityError: () => actionability.externalNetwork,
  ContainerPullError: () => actionability.externalNetwork,
  StackRuntimeError: () => actionability.startStack,
  StackCleanupError: () => actionability.stopStack,
  ContainerEngineError: () => actionability.dockerNotRunning,
  StackDestructionError: () => actionability.stopStack,
  BinaryNotFoundError: () => actionability.invalidConfig,
  BinaryManifestError: () => actionability.externalNetwork,
  BinaryRuntimeError: () => actionability.externalNetwork,
  BinaryHostCompatibilityError: () => actionability.invalidConfig,
  DownloadError: () => actionability.externalNetwork,
  ChecksumMismatchError: () => ({
    ...actionability.externalNetwork,
    fingerprint_suffix: "asset_checksum",
  }),
  DockerPullError: (error) =>
    error["daemonDown"] === true
      ? { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" }
      : { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" },
  PortAllocationError: () => ({
    ...actionability.invalidConfig,
    fingerprint_suffix: "port_allocation",
  }),
  StackNotRunningError: () => actionability.startStack,
  StackRpcProtocolError: () => ({
    ...actionability.impossibleState,
    fingerprint_suffix: "daemon_protocol",
  }),
  ManagedStackAttachedError: () => ({
    ...actionability.stopStack,
    fingerprint_suffix: "managed_attached",
  }),
  ManagedWorkspaceRepairConflictError: () => ({
    ...actionability.invalidInput,
    fingerprint_suffix: "managed_workspace_repair",
  }),
  DaemonStartError: () => actionability.unknown,
  SupervisorStartError: () => ({
    ...actionability.startStack,
    fingerprint_suffix: "daemon_start",
  }),
  // Transport failures retain the existing stack-recovery policy. An HTTP
  // status or protocol failure came from the CLI-owned daemon itself and is
  // therefore an internal invariant failure, not user configuration.
  HttpTransportClientError: (error) => {
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
};

/**
 * Whether a tag defined outside `apps/cli` has an external adapter. Used by
 * the coverage test to keep {@link externalActionabilityByTag} exhaustive
 * against the workspace packages.
 */
export function isClassifiedExternalErrorTag(tag: string): boolean {
  return Object.hasOwn(externalActionabilityByTag, tag);
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

  if (tag !== undefined && isErrorRecord(error)) {
    // Own-property lookup: a sanitized tag like "constructor" must not pick
    // up Object.prototype members as adapters.
    if (Object.hasOwn(externalActionabilityByTag, tag)) {
      const external = externalActionabilityByTag[tag];
      if (external !== undefined) {
        return toActionability(external(error), "tag", tag);
      }
    }
    return toActionability(actionability.unknown, "tag", undefined);
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
