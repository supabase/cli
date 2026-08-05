import {
  ProjectConfigSchema,
  type LoadedProjectConfig,
  type ProjectConfig,
  type ProjectEnvironment,
} from "@supabase/config";
import type { ReadinessPolicy, StackConfig, VersionManifest } from "@supabase/stack/effect";
import { Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { legacyParseGoDuration } from "../../shared/config/go-duration.ts";
import { translateAuthStackConfig } from "./auth-stack-config.ts";
import {
  excludedStackServices,
  invalidLocalStackConfig,
  LocalStackConfigError,
  resolveCoreStackConfig,
  type ExcludedStackService,
} from "./core-stack-config.ts";
import { translateDatabaseBootstrapConfig } from "./database-bootstrap-config.ts";
import { DataPlaneStackConfigError } from "./data-plane-stack-config-values.ts";
import { resolveDataPlaneStackConfig } from "./data-plane-stack-config.ts";
import {
  flattenLocalStackConfigParity,
  type LocalStackConfigParityDecision,
} from "./local-stack-config-parity.ts";

export { excludedStackServices, LocalStackConfigError, type ExcludedStackService };
export const startModes = ["native", "auto", "docker"] as const;
export type StartMode = (typeof startModes)[number];

const LEGACY_NON_DATABASE_READINESS_BUDGET_MS = 30_000;
const decodeDefaultProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const defaultProjectConfig = decodeDefaultProjectConfig({});

interface LocalStackProjectPaths {
  readonly projectRoot: string;
  readonly projectStateRoot: string;
}

export interface LocalStackLaunchInput {
  readonly loadedProjectConfig: LoadedProjectConfig | null;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly projectPaths: LocalStackProjectPaths;
  readonly mode: StartMode;
  readonly exclude: ReadonlyArray<ExcludedStackService>;
  readonly runtimeVersions: Partial<VersionManifest>;
  /** Managed project launches are lazy; diagnostic callers may request eager startup. */
  readonly startupMode?: "eager" | "lazy";
  /** Interactive diagnostics may opt out of deadlines; ordinary starts are finite. */
  readonly readiness?: "finite" | "infinite";
}

export interface LocalStackWarning {
  readonly code: "unsupported" | "deprecated" | "unmatched-seed-pattern";
  readonly paths: ReadonlyArray<string>;
  readonly message: string;
}

interface ResolvedLocalStackLaunch {
  readonly stackConfig: StackConfig;
  readonly projectPaths: LocalStackProjectPaths;
  readonly warnings: ReadonlyArray<LocalStackWarning>;
}

interface PresentConfigValue {
  readonly path: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandPresentValues(
  root: unknown,
  segments: ReadonlyArray<string>,
  prefix = "",
): ReadonlyArray<PresentConfigValue> {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return [{ path: prefix, value: root }];
  }
  if (!isRecord(root)) {
    return [];
  }

  if (segment === "*") {
    return Object.entries(root).flatMap(([key, value]) =>
      expandPresentValues(value, rest, prefix === "" ? key : `${prefix}.${key}`),
    );
  }

  if (!(segment in root)) {
    return [];
  }
  return expandPresentValues(root[segment], rest, prefix === "" ? segment : `${prefix}.${segment}`);
}

function hasMeaningfulDecodedValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

export interface ExplicitLocalStackConfigEntry {
  readonly path: string;
  readonly decision: LocalStackConfigParityDecision;
}

/** Resolves presence-sensitive ledger decisions without ever retaining field values. */
export function explicitLocalStackConfigEntries(input: {
  readonly projectConfig: ProjectConfig;
  readonly rawDocument?: Readonly<Record<string, unknown>>;
}): ReadonlyArray<ExplicitLocalStackConfigEntry> {
  return flattenLocalStackConfigParity().flatMap(({ path, decision }) => {
    const source = decision.presence === "raw-document" ? input.rawDocument : input.projectConfig;
    if (source === undefined) {
      return [];
    }
    return expandPresentValues(source, path.split("."))
      .filter(({ value }) =>
        decision.presence === "raw-document" ? true : hasMeaningfulDecodedValue(value),
      )
      .map(({ path: explicitPath }) => ({ path: explicitPath, decision }));
  });
}

function diagnosticsFor(input: {
  readonly projectConfig: ProjectConfig;
  readonly rawDocument?: Readonly<Record<string, unknown>>;
}): {
  readonly warnings: ReadonlyArray<LocalStackWarning>;
  readonly blockingPaths: ReadonlyArray<string>;
} {
  const entries = explicitLocalStackConfigEntries(input);
  const warningPaths = entries
    .filter(({ decision }) => decision._tag === "unsupported-warning")
    .map(({ path }) => path)
    .sort();
  const blockingPaths = entries
    .filter(({ decision }) => decision._tag === "unsupported-blocking")
    .map(({ path }) => path)
    .sort();

  return {
    warnings:
      warningPaths.length === 0
        ? []
        : [
            {
              code: "unsupported",
              paths: warningPaths,
              message: `The next local stack does not yet apply these experimental settings: ${warningPaths.join(", ")}.`,
            },
          ],
    blockingPaths,
  };
}

export function baseStackConfig(
  exclude: ReadonlyArray<ExcludedStackService>,
  mode: StartMode,
  startupMode: "eager" | "lazy" = "lazy",
): StackConfig {
  const excluded = new Set(exclude);
  return {
    mode,
    startupMode,
    edgeRuntime: excluded.has("edge-runtime") ? false : {},
    realtime: excluded.has("realtime") ? false : {},
    storage: excluded.has("storage") ? false : {},
    imgproxy: excluded.has("imgproxy") || excluded.has("storage") ? false : {},
    mailpit: excluded.has("mailpit") ? false : {},
    pgmeta: excluded.has("pgmeta") ? false : {},
    studio: excluded.has("studio") || excluded.has("pgmeta") ? false : {},
    analytics: excluded.has("analytics") ? false : {},
    vector: excluded.has("vector") || excluded.has("analytics") ? false : {},
    pooler: excluded.has("pooler") ? false : {},
    ...(excluded.has("auth") ? { auth: false } : {}),
    ...(excluded.has("postgrest") ? { postgrest: false } : {}),
  };
}

function withServiceVersions(
  stackConfig: StackConfig,
  versions: Partial<VersionManifest>,
): StackConfig {
  return {
    ...stackConfig,
    postgres:
      versions.postgres === undefined
        ? stackConfig.postgres
        : { ...stackConfig.postgres, version: versions.postgres },
    postgrest:
      stackConfig.postgrest === false || versions.postgrest === undefined
        ? stackConfig.postgrest
        : { ...stackConfig.postgrest, version: versions.postgrest },
    auth:
      stackConfig.auth === false || versions.auth === undefined
        ? stackConfig.auth
        : { ...stackConfig.auth, version: versions.auth },
    realtime:
      stackConfig.realtime === false || versions.realtime === undefined
        ? stackConfig.realtime
        : { ...stackConfig.realtime, version: versions.realtime },
    storage:
      stackConfig.storage === false || versions.storage === undefined
        ? stackConfig.storage
        : { ...stackConfig.storage, version: versions.storage },
    imgproxy:
      stackConfig.imgproxy === false || versions.imgproxy === undefined
        ? stackConfig.imgproxy
        : { ...stackConfig.imgproxy, version: versions.imgproxy },
    mailpit:
      stackConfig.mailpit === false || versions.mailpit === undefined
        ? stackConfig.mailpit
        : { ...stackConfig.mailpit, version: versions.mailpit },
    pgmeta:
      stackConfig.pgmeta === false || versions.pgmeta === undefined
        ? stackConfig.pgmeta
        : { ...stackConfig.pgmeta, version: versions.pgmeta },
    studio:
      stackConfig.studio === false || versions.studio === undefined
        ? stackConfig.studio
        : { ...stackConfig.studio, version: versions.studio },
    analytics:
      stackConfig.analytics === false || versions.analytics === undefined
        ? stackConfig.analytics
        : { ...stackConfig.analytics, version: versions.analytics },
    vector:
      stackConfig.vector === false || versions.vector === undefined
        ? stackConfig.vector
        : { ...stackConfig.vector, version: versions.vector },
    pooler:
      stackConfig.pooler === false || versions.pooler === undefined
        ? stackConfig.pooler
        : { ...stackConfig.pooler, version: versions.pooler },
  };
}

export function resolveStoredStackLaunch(input: {
  readonly exclude: ReadonlyArray<ExcludedStackService>;
  readonly mode: StartMode;
  readonly runtimeVersions: Partial<VersionManifest>;
  readonly startupMode?: "eager" | "lazy";
}): StackConfig {
  return withServiceVersions(
    baseStackConfig(input.exclude, input.mode, input.startupMode),
    input.runtimeVersions,
  );
}

export function resolveFunctionsDevStackLaunch(
  runtimeVersions: Partial<VersionManifest>,
): StackConfig {
  return resolveStoredStackLaunch({ exclude: [], mode: "auto", runtimeVersions });
}

function resolvePostgresStartupTimeout(input: {
  readonly projectConfig: ProjectConfig;
  readonly projectEnvironment: ProjectEnvironment | null;
}): Effect.Effect<number, LocalStackConfigError> {
  const configured =
    input.projectEnvironment?.values["SUPABASE_DB_HEALTH_TIMEOUT"] ??
    input.projectConfig.db.health_timeout;

  return Effect.try({
    try: () => {
      const postgresStartupTimeoutMs = Math.trunc(legacyParseGoDuration(configured) / 1_000_000);
      if (postgresStartupTimeoutMs < 0) {
        throw new Error("duration must not be negative");
      }
      return postgresStartupTimeoutMs;
    },
    catch: () =>
      invalidLocalStackConfig(
        "db.health_timeout",
        "Use a non-negative Go duration such as 2m or 30s.",
      ),
  });
}

export const resolveLocalStackLaunch = Effect.fnUntraced(function* (input: LocalStackLaunchInput) {
  const projectConfig = input.loadedProjectConfig?.config ?? defaultProjectConfig;
  const postgresStartupTimeoutMs = yield* resolvePostgresStartupTimeout({
    projectConfig,
    projectEnvironment: input.projectEnvironment,
  });
  const readiness: ReadinessPolicy =
    input.readiness === "infinite"
      ? { mode: "infinite" }
      : {
          mode: "finite",
          timeoutMs: postgresStartupTimeoutMs + LEGACY_NON_DATABASE_READINESS_BUDGET_MS,
        };
  const { autoExposeNewTables, deprecationWarning } = resolveAutoExposeNewTables(
    projectConfig.api.auto_expose_new_tables,
  );
  const diagnostics = diagnosticsFor({
    projectConfig,
    rawDocument: input.loadedProjectConfig?.document,
  });
  if (diagnostics.blockingPaths.length > 0) {
    return yield* Effect.fail(
      new LocalStackConfigError({
        detail: `The next local stack does not yet support these explicitly configured settings: ${diagnostics.blockingPaths.join(", ")}.`,
        suggestion:
          "Remove these settings for now, or use the legacy local stack until their parity slice is available.",
        paths: diagnostics.blockingPaths,
      }),
    );
  }
  const versionedConfig = resolveStoredStackLaunch({
    exclude: input.exclude,
    mode: input.mode,
    runtimeVersions: input.runtimeVersions,
    startupMode: input.startupMode,
  });
  const coreConfig = yield* Effect.try({
    try: () =>
      resolveCoreStackConfig({
        projectConfig,
        rawDocument: input.loadedProjectConfig?.document,
        projectEnvironment: input.projectEnvironment,
        exclude: input.exclude,
        base: versionedConfig,
      }),
    catch: (cause) =>
      cause instanceof LocalStackConfigError
        ? cause
        : new LocalStackConfigError({
            detail: "Invalid local stack configuration.",
            suggestion: "Review the configured service topology and port values.",
            paths: [],
          }),
  });
  const translatedAuth = yield* translateAuthStackConfig({
    projectConfig,
    rawDocument: input.loadedProjectConfig?.document,
    projectEnvironment: input.projectEnvironment,
    configDir:
      input.loadedProjectConfig === null
        ? join(input.projectPaths.projectRoot, "supabase")
        : dirname(input.loadedProjectConfig.path),
    authEnabled: coreConfig.auth !== false,
  });
  const translatedDatabaseBootstrap = yield* translateDatabaseBootstrapConfig({
    loadedProjectConfig: input.loadedProjectConfig,
    projectEnvironment: input.projectEnvironment,
    projectRoot: input.projectPaths.projectRoot,
  });
  const databaseWarnings = translatedDatabaseBootstrap.warnings.map(
    (warning): LocalStackWarning => ({ code: "unmatched-seed-pattern", ...warning }),
  );
  const deprecationWarnings: ReadonlyArray<LocalStackWarning> =
    deprecationWarning === undefined
      ? []
      : [
          {
            code: "deprecated",
            paths: ["api.auto_expose_new_tables"],
            message: deprecationWarning,
          },
        ];
  const dataPlaneConfig = yield* Effect.try({
    try: () =>
      resolveDataPlaneStackConfig({
        projectConfig,
        projectEnvironment: input.projectEnvironment,
        configDir:
          input.loadedProjectConfig === null
            ? join(input.projectPaths.projectRoot, "supabase")
            : dirname(input.loadedProjectConfig.path),
        base: coreConfig,
      }),
    catch: (cause) =>
      cause instanceof DataPlaneStackConfigError
        ? cause
        : new DataPlaneStackConfigError({
            detail: "Invalid data-plane service configuration.",
            suggestion: "Review the configured data-plane service values.",
            paths: [],
          }),
  });

  return {
    stackConfig: {
      ...dataPlaneConfig,
      projectDir: input.projectPaths.projectRoot,
      readiness,
      credentials: translatedAuth.credentials,
      databaseBootstrap: translatedDatabaseBootstrap.config,
      auth:
        translatedAuth.auth === false
          ? false
          : {
              ...translatedAuth.auth,
              version: versionedConfig.auth === false ? undefined : versionedConfig.auth?.version,
            },
      postgres: {
        ...dataPlaneConfig.postgres,
        autoExposeNewTables,
        startupHealthTimeoutMs: postgresStartupTimeoutMs,
      },
    },
    projectPaths: input.projectPaths,
    warnings: [...diagnostics.warnings, ...databaseWarnings, ...deprecationWarnings],
  } satisfies ResolvedLocalStackLaunch;
});

export const AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING =
  "api.auto_expose_new_tables is deprecated and will be removed on 2026-10-30. Remove the field or set it to false to adopt the new default of revoking Data API privileges on new entities in the public schema.";

export function resolveAutoExposeNewTables(value: boolean | undefined): {
  readonly autoExposeNewTables: boolean;
  readonly deprecationWarning: string | undefined;
} {
  return {
    autoExposeNewTables: value ?? false,
    deprecationWarning: value === true ? AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING : undefined,
  };
}
