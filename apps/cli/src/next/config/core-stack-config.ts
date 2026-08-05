import type { LoadedProjectConfig, ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { StackConfig } from "@supabase/stack/effect";
import { Data } from "effect";
import {
  effectiveEnvironmentOverride,
  effectiveString,
  effectiveStringList,
  parseGoBoolean,
  parseGoUint32,
} from "./local-stack-config-values.ts";

export const excludedStackServices = [
  "auth",
  "edge-runtime",
  "postgrest",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const;

export type ExcludedStackService = (typeof excludedStackServices)[number];

export class LocalStackConfigError extends Data.TaggedError("LocalStackConfigError")<{
  readonly detail: string;
  readonly suggestion: string;
  readonly paths: ReadonlyArray<string>;
}> {}

export function invalidLocalStackConfig(path: string, suggestion: string): LocalStackConfigError {
  return new LocalStackConfigError({
    detail: `Invalid local stack configuration at ${path}.`,
    suggestion,
    paths: [path],
  });
}

function environmentOverride(
  path: string,
  configured: string | undefined,
  environment: ProjectEnvironment | null,
  loaded: LoadedProjectConfig | null,
): string | undefined {
  return effectiveEnvironmentOverride({ loaded, environment, path }) ?? configured;
}

function resolveBoolean(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly configured: boolean;
  readonly path: string;
}): boolean {
  const override = effectiveEnvironmentOverride(input);
  if (override === undefined) return input.configured;
  const resolved = parseGoBoolean(override);
  if (resolved === undefined) {
    throw invalidLocalStackConfig(
      input.path,
      "Use a Go-compatible boolean such as true, false, 1, or 0.",
    );
  }
  return resolved;
}

function parseGoPort(value: string): number | undefined {
  const signless = value.startsWith("+") ? value.slice(1) : value;
  if (signless.length === 0 || signless.startsWith("-")) return undefined;
  let base = 10;
  let digits = signless;
  if (/^0[xX]/.test(signless)) {
    base = 16;
    digits = signless.slice(2);
  } else if (/^0[oO]/.test(signless)) {
    base = 8;
    digits = signless.slice(2);
  } else if (/^0[0-7]+$/.test(signless)) {
    base = 8;
    digits = signless.slice(1);
  }
  if (digits.length === 0) return undefined;
  const validDigits = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!validDigits.test(digits)) return undefined;
  const parsed = Number.parseInt(digits, base);
  return Number.isSafeInteger(parsed) && parsed <= 65_535 ? parsed : undefined;
}

function resolvePort(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly configured: number | undefined;
  readonly path: string;
  readonly required?: boolean;
}): number | undefined {
  const override = effectiveEnvironmentOverride(input);
  const resolved = override === undefined ? input.configured : parseGoPort(override);
  if (resolved === undefined && input.required !== true && override === undefined) return undefined;
  if (
    resolved === undefined ||
    !Number.isInteger(resolved) ||
    resolved < 0 ||
    resolved > 65_535 ||
    (input.required === true && resolved === 0)
  ) {
    throw invalidLocalStackConfig(input.path, "Use an integer port between 1 and 65535.");
  }
  return resolved;
}

function serviceConfig<T extends object>(base: T | false | undefined, values: T): T {
  return { ...(base === false ? {} : base), ...values };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveEdgeRuntimePolicy(value: string): "oneshot" | "per_worker" {
  if (value === "oneshot" || value === "per_worker") return value;
  throw invalidLocalStackConfig("edge_runtime.policy", "Use either oneshot or per_worker.");
}

function resolveAnalyticsBackend(value: string): "postgres" | "bigquery" {
  if (value === "postgres" || value === "bigquery") return value;
  throw invalidLocalStackConfig("analytics.backend", "Use either postgres or bigquery.");
}

function resolvePoolMode(value: string): "transaction" | "session" {
  if (value === "transaction" || value === "session") return value;
  throw invalidLocalStackConfig("db.pooler.pool_mode", "Use either transaction or session.");
}

export function resolveCoreStackConfig(input: {
  readonly loadedProjectConfig: LoadedProjectConfig | null;
  readonly projectConfig: ProjectConfig;
  readonly rawDocument?: Readonly<Record<string, unknown>>;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly exclude: ReadonlyArray<ExcludedStackService>;
  readonly base: StackConfig;
}): StackConfig {
  const { projectConfig, projectEnvironment } = input;
  const excluded = new Set(input.exclude);
  const enabled = (params: {
    readonly configured: boolean;
    readonly path: string;
    readonly excludedAs: ExcludedStackService;
  }) =>
    resolveBoolean({
      loaded: input.loadedProjectConfig,
      environment: projectEnvironment,
      configured: params.configured,
      path: params.path,
    }) && !excluded.has(params.excludedAs);

  const apiEnabled = enabled({
    configured: projectConfig.api.enabled,
    path: "api.enabled",
    excludedAs: "postgrest",
  });
  const authEnabled = enabled({
    configured: projectConfig.auth.enabled,
    path: "auth.enabled",
    excludedAs: "auth",
  });
  const realtimeEnabled = enabled({
    configured: projectConfig.realtime.enabled,
    path: "realtime.enabled",
    excludedAs: "realtime",
  });
  const storageEnabled = enabled({
    configured: projectConfig.storage.enabled,
    path: "storage.enabled",
    excludedAs: "storage",
  });
  const mailpitEnabled = enabled({
    configured: projectConfig.local_smtp.enabled,
    path: "local_smtp.enabled",
    excludedAs: "mailpit",
  });
  const studioEnabled = enabled({
    configured: projectConfig.studio.enabled,
    path: "studio.enabled",
    excludedAs: "studio",
  });
  const analyticsEnabled = enabled({
    configured: projectConfig.analytics.enabled,
    path: "analytics.enabled",
    excludedAs: "analytics",
  });
  const poolerEnabled = enabled({
    configured: projectConfig.db.pooler.enabled,
    path: "db.pooler.enabled",
    excludedAs: "pooler",
  });
  const edgeRuntimeEnabled = enabled({
    configured: projectConfig.edge_runtime.enabled,
    path: "edge_runtime.enabled",
    excludedAs: "edge-runtime",
  });
  const imageTransformationSection = isRecord(input.rawDocument?.storage)
    ? input.rawDocument.storage.image_transformation
    : undefined;
  const imageTransformationEnabled =
    isRecord(imageTransformationSection) &&
    resolveBoolean({
      loaded: input.loadedProjectConfig,
      environment: projectEnvironment,
      configured: projectConfig.storage.image_transformation?.enabled ?? false,
      path: "storage.image_transformation.enabled",
    });

  const apiPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.api.port,
    path: "api.port",
    required: apiEnabled,
  });
  const dbPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.db.port,
    path: "db.port",
    required: true,
  });
  const studioPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.studio.port,
    path: "studio.port",
    required: studioEnabled,
  });
  const mailpitPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.local_smtp.port,
    path: "local_smtp.port",
    required: mailpitEnabled,
  });
  const mailpitSmtpPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.local_smtp.smtp_port,
    path: "local_smtp.smtp_port",
  });
  const mailpitPop3Port = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.local_smtp.pop3_port,
    path: "local_smtp.pop3_port",
  });
  const analyticsPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.analytics.port,
    path: "analytics.port",
    required: analyticsEnabled,
  });
  const poolerPort = resolvePort({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    configured: projectConfig.db.pooler.port,
    path: "db.pooler.port",
    required: poolerEnabled,
  });
  const maxRowsOverride = effectiveEnvironmentOverride({
    loaded: input.loadedProjectConfig,
    environment: projectEnvironment,
    path: "api.max_rows",
  });
  const maxRows =
    maxRowsOverride === undefined ? projectConfig.api.max_rows : parseGoUint32(maxRowsOverride);
  if (maxRows === undefined) {
    throw invalidLocalStackConfig("api.max_rows", "Use a non-negative 32-bit integer.");
  }

  return {
    ...input.base,
    port: apiPort,
    postgres: serviceConfig(input.base.postgres, { port: dbPort }),
    postgrest: apiEnabled
      ? serviceConfig(input.base.postgrest, {
          schemas: effectiveStringList({
            loaded: input.loadedProjectConfig,
            environment: projectEnvironment,
            path: "api.schemas",
            configured: projectConfig.api.schemas,
          }),
          extraSearchPath: effectiveStringList({
            loaded: input.loadedProjectConfig,
            environment: projectEnvironment,
            path: "api.extra_search_path",
            configured: projectConfig.api.extra_search_path,
          }),
          maxRows,
        })
      : false,
    auth: authEnabled ? serviceConfig(input.base.auth, {}) : false,
    edgeRuntime: edgeRuntimeEnabled
      ? serviceConfig(input.base.edgeRuntime, {
          policy: resolveEdgeRuntimePolicy(
            effectiveString({
              loaded: input.loadedProjectConfig,
              environment: projectEnvironment,
              path: "edge_runtime.policy",
              configured: projectConfig.edge_runtime.policy,
            }),
          ),
        })
      : false,
    realtime: realtimeEnabled
      ? serviceConfig(input.base.realtime, {
          maxHeaderLength: projectConfig.realtime.max_header_length,
        })
      : false,
    storage: storageEnabled
      ? serviceConfig(input.base.storage, {
          fileSizeLimit: projectConfig.storage.file_size_limit,
          s3ProtocolEnabled: projectConfig.storage.s3_protocol.enabled,
        })
      : false,
    imgproxy:
      storageEnabled && imageTransformationEnabled && !excluded.has("imgproxy")
        ? serviceConfig(input.base.imgproxy, {})
        : false,
    mailpit: mailpitEnabled
      ? serviceConfig(input.base.mailpit, {
          port: mailpitPort,
          ...(mailpitSmtpPort === undefined || mailpitSmtpPort === 0
            ? {}
            : { smtpPort: mailpitSmtpPort }),
          ...(mailpitPop3Port === undefined || mailpitPop3Port === 0
            ? {}
            : { pop3Port: mailpitPop3Port }),
          adminEmail: environmentOverride(
            "local_smtp.admin_email",
            projectConfig.local_smtp.admin_email,
            projectEnvironment,
            input.loadedProjectConfig,
          ),
          senderName: environmentOverride(
            "local_smtp.sender_name",
            projectConfig.local_smtp.sender_name,
            projectEnvironment,
            input.loadedProjectConfig,
          ),
        })
      : false,
    pgmeta: studioEnabled && !excluded.has("pgmeta") ? input.base.pgmeta : false,
    studio:
      studioEnabled && !excluded.has("pgmeta")
        ? serviceConfig(input.base.studio, {
            port: studioPort,
            apiUrl:
              environmentOverride(
                "studio.api_url",
                projectConfig.studio.api_url,
                projectEnvironment,
                input.loadedProjectConfig,
              ) ?? projectConfig.studio.api_url,
          })
        : false,
    analytics: analyticsEnabled
      ? serviceConfig(input.base.analytics, {
          port: analyticsPort,
          backend: resolveAnalyticsBackend(projectConfig.analytics.backend),
        })
      : false,
    vector:
      analyticsEnabled && !excluded.has("vector") ? serviceConfig(input.base.vector, {}) : false,
    pooler: poolerEnabled
      ? serviceConfig(input.base.pooler, {
          port: poolerPort,
          mode: resolvePoolMode(projectConfig.db.pooler.pool_mode),
          defaultPoolSize: projectConfig.db.pooler.default_pool_size,
          maxClientConn: projectConfig.db.pooler.max_client_conn,
        })
      : false,
  };
}
