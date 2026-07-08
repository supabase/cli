import { Cause, Option } from "effect";

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
 * suggestion types, and fingerprints are closed enums or `tag:`-prefixed safe
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
  UpgradePlan: "upgrade_plan",
  RerunDebug: "rerun_debug",
  OpenDashboard: "open_dashboard",
  None: "none",
} as const;

export type CliSuggestionType = (typeof CliSuggestionType)[keyof typeof CliSuggestionType];

/** Q2 KPI metric definitions, kept next to the taxonomy they consume. */
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

/**
 * Symbol under which CLI error classes declare their own actionability.
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
export const ErrorActionabilityId: unique symbol = Symbol.for(
  "@supabase/cli/telemetry/ErrorActionability",
);

export interface CliErrorActionabilityDeclaration {
  readonly error_kind: CliErrorKind;
  readonly error_category: CliErrorCategory;
  /**
   * Whether this failure class has a canonical remediation. This is the
   * taxonomy-level claim, not a guarantee that the CLI rendered a
   * `Suggestion:` line for a given instance — some errors convey the fix in
   * the message itself. When CLI-1561 wires capture, the emitted
   * `has_suggestion` should be reconciled with what the output layer actually
   * rendered so telemetry can never disagree with what the user saw.
   */
  readonly has_suggestion: boolean;
  readonly suggestion_type: CliSuggestionType;
  readonly suggested_command?: string;
  /**
   * Distinguishes branches of instance-dependent declarations in the repeat
   * fingerprint, so e.g. a registry pull failure and a daemon-down failure of
   * the same wrapper tag never count as repeats of one another. Must be a
   * static safe identifier, never derived from error text.
   */
  readonly fingerprint_suffix?: string;
}

/** Sanitized classification emitted with failed `cli_command_executed` events. */
export interface CliErrorActionability {
  readonly error_kind: CliErrorKind;
  readonly error_category: CliErrorCategory;
  readonly error_fingerprint: string;
  readonly has_suggestion: boolean;
  readonly suggestion_type: CliSuggestionType;
  readonly suggested_command?: string;
}

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
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpdateConfig,
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
    suggestion_type: CliSuggestionType.UpdateConfig,
    suggested_command: "supabase start",
  },
  stopStack: {
    error_kind: CliErrorKind.UserActionable,
    error_category: CliErrorCategory.InvalidConfig,
    has_suggestion: true,
    suggestion_type: CliSuggestionType.UpdateConfig,
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
 * Classification policy for errors that carry a Management API status code.
 * `upgradeSuggested` is the typed result of the entitlement gate
 * (`legacySuggestUpgrade`) threaded through the error constructor — never
 * inferred from message text.
 */
export function statusCodeActionability(
  status: number | undefined,
  opts: { readonly upgradeSuggested?: boolean } = {},
): CliErrorActionabilityDeclaration {
  if (status === 401) {
    return { ...actionability.authLogin, fingerprint_suffix: "auth" };
  }
  if (opts.upgradeSuggested === true && status !== undefined && status >= 400 && status < 500) {
    return { ...actionability.planLimit, fingerprint_suffix: "plan_limit" };
  }
  if (status === 403) {
    return { ...actionability.accountAccess, fingerprint_suffix: "forbidden" };
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

const kindValues = new Set<string>(Object.values(CliErrorKind));
const categoryValues = new Set<string>(Object.values(CliErrorCategory));
const suggestionValues = new Set<string>(Object.values(CliSuggestionType));

function isDeclaration(value: unknown): value is CliErrorActionabilityDeclaration {
  if (!isErrorRecord(value)) return false;
  const kind = value["error_kind"];
  const category = value["error_category"];
  const suggestion = value["suggestion_type"];
  return (
    typeof kind === "string" &&
    kindValues.has(kind) &&
    typeof category === "string" &&
    categoryValues.has(category) &&
    typeof value["has_suggestion"] === "boolean" &&
    typeof suggestion === "string" &&
    suggestionValues.has(suggestion)
  );
}

function readDeclaration(error: unknown): CliErrorActionabilityDeclaration | undefined {
  if (!isErrorRecord(error)) return undefined;
  if (!(ErrorActionabilityId in error)) return undefined;
  const declared = error[ErrorActionabilityId];
  return isDeclaration(declared) ? declared : undefined;
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

function toActionability(
  declaration: CliErrorActionabilityDeclaration,
  fingerprintPrefix: string,
  identifier: string | undefined,
): CliErrorActionability {
  const { fingerprint_suffix, ...rest } = declaration;
  return {
    ...rest,
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
const externalActionabilityByTag: Record<
  string,
  (error: ErrorRecord) => CliErrorActionabilityDeclaration
> = {
  // effect/unstable/cli parser failures (ShowHelp and UserError recurse in
  // classifyCliErrorActionability instead of mapping here)
  MissingOption: () => actionability.invalidInput,
  MissingArgument: () => actionability.invalidInput,
  DuplicateOption: () => actionability.invalidInput,
  InvalidValue: () => actionability.invalidInput,
  UnknownSubcommand: () => actionability.invalidInput,
  UnrecognizedOption: () => actionability.invalidInput,

  // effect PlatformError — OS/filesystem operations. `reason` is
  // `BadArgument | SystemError`; BadArgument means the CLI itself passed a
  // rejected argument (internal bug), SystemError reasons are local
  // environment problems the user resolves.
  PlatformError: (error) => {
    const reason = error["reason"];
    const reasonTag = isErrorRecord(reason)
      ? safeIdentifier(readString(reason, "_tag"))
      : undefined;
    if (reasonTag === "BadArgument") {
      return { ...actionability.impossibleState, fingerprint_suffix: "bad_argument" };
    }
    return {
      ...actionability.permission,
      ...(reasonTag !== undefined ? { fingerprint_suffix: reasonTag } : {}),
    };
  },
  BadArgument: () => ({ ...actionability.impossibleState, fingerprint_suffix: "bad_argument" }),

  // @supabase/config
  ProjectConfigParseError: () => actionability.invalidConfig,
  ProjectEnvParseError: () => actionability.invalidConfig,
  MissingProjectConfigValueError: () => actionability.invalidConfig,
  DuplicateRemoteProjectIdError: () => actionability.invalidConfig,

  // @supabase/api — client construction failed before any request (missing
  // access token / bad configuration); remediation is the token env var.
  SupabaseApiConfigError: () => actionability.authToken,

  // effect/unstable/http — generated Management API client transport/decoding
  HttpClientError: (error) => {
    const reason = error["reason"];
    const reasonTag = isErrorRecord(reason) ? readString(reason, "_tag") : undefined;
    const response = error["response"];
    const status = isErrorRecord(response) ? readNumber(response, "status") : undefined;
    if (status === 401) return { ...actionability.authLogin, fingerprint_suffix: "auth" };
    if (status === 403) return { ...actionability.accountAccess, fingerprint_suffix: "forbidden" };
    if (reasonTag === "StatusCodeError" || isErrorRecord(response)) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
    }
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  },
  HttpBodyError: () => ({ ...actionability.apiStatus, fingerprint_suffix: "api_response" }),
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
  StackMetadataNotFoundError: () => actionability.startStack,
  InvalidStackStateError: () => actionability.invalidConfig,
  InvalidStackMetadataError: () => actionability.invalidConfig,
  UnsupportedStackMetadataVersionError: () => actionability.invalidConfig,
  NoRunningStackError: () => actionability.startStack,
  StackAlreadyRunningError: () => actionability.stopStack,
  DaemonStartError: () => actionability.startStack,
  DaemonStillRunningError: () => actionability.stopStack,
  UnixHttpClientError: () => actionability.stopStack,

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

function classifyShowHelp(error: ErrorRecord): CliErrorActionability | undefined {
  const errors = error["errors"];
  if (!Array.isArray(errors)) return undefined;
  if (errors.length === 1) return classifyCliErrorActionability(errors[0]);
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

export function classifyCliErrorActionability(error: unknown): CliErrorActionability {
  const tag = readErrorTag(error);

  const declared = readDeclaration(error);
  if (declared !== undefined) {
    return toActionability(declared, "tag", tag ?? readErrorName(error));
  }

  if (tag === "ShowHelp" && isErrorRecord(error)) {
    const classified = classifyShowHelp(error);
    if (classified !== undefined) return classified;
  }

  // effect cli wraps handler failures in UserError({ cause }) — classify the
  // actual failure instead of the wrapper.
  if (tag === "UserError" && isErrorRecord(error) && error["cause"] !== undefined) {
    return classifyCliErrorActionability(error["cause"]);
  }

  // @supabase/stack wrapper errors preserve the underlying tagged failure in
  // `cause`; classify it when it is more specific than the wrapper (e.g. a
  // daemon-down DockerPullError inside an asset-preparation StackBuildError,
  // or a local filesystem PlatformError inside a DownloadError).
  if (
    isErrorRecord(error) &&
    (tag === "DownloadError" ||
      (tag === "StackBuildError" && readString(error, "reason") === "asset_preparation"))
  ) {
    const cause = classifiableCause(error);
    if (cause !== undefined) {
      return classifyCliErrorActionability(cause);
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
    return toActionability(actionability.unknown, "tag", tag);
  }

  if (isErrorRecord(error) && readErrorName(error) === "StackError") {
    // The public Stack promise API wraps tagged failures via `toStackError`,
    // preserving the original in `cause` — classify that instead of the
    // wrapper whenever it is itself classifiable.
    const cause = classifiableCause(error);
    if (cause !== undefined) {
      return classifyCliErrorActionability(cause);
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

  return toActionability(actionability.unknown, "error", name);
}

export function classifyCliCauseActionability(cause: Cause.Cause<unknown>): CliErrorActionability {
  const error = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause));
  return classifyCliErrorActionability(error);
}
