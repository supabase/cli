import type { ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { StackConfig } from "@supabase/stack/effect";
import { Data } from "effect";

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

const GO_BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  "1": true,
  t: true,
  T: true,
  TRUE: true,
  true: true,
  True: true,
  "0": false,
  f: false,
  F: false,
  FALSE: false,
  false: false,
  False: false,
};

export function invalidLocalStackConfig(path: string, suggestion: string): LocalStackConfigError {
  return new LocalStackConfigError({
    detail: `Invalid local stack configuration at ${path}.`,
    suggestion,
    paths: [path],
  });
}

function environmentOverride(
  name: string,
  configured: string | undefined,
  environment: ProjectEnvironment | null,
): string | undefined {
  const value = environment?.values[name];
  if (value === undefined || value.length === 0) return configured;
  const match = /^env\(([^)]+)\)$/.exec(value);
  if (match === null) return value;
  const referencedName = match[1];
  if (referencedName === undefined) return value;
  const referenced = environment?.values[referencedName];
  return referenced === undefined || referenced.length === 0 ? value : referenced;
}

function resolveBoolean(input: {
  readonly environment: ProjectEnvironment | null;
  readonly envName: string;
  readonly configured: boolean;
  readonly path: string;
}): boolean {
  const override = environmentOverride(input.envName, undefined, input.environment);
  if (override === undefined) return input.configured;
  const resolved = GO_BOOLEAN_VALUES[override];
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
  readonly environment: ProjectEnvironment | null;
  readonly envName: string;
  readonly configured: number | undefined;
  readonly path: string;
  readonly required?: boolean;
}): number | undefined {
  const override = environmentOverride(input.envName, undefined, input.environment);
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
  readonly projectConfig: ProjectConfig;
  readonly rawDocument?: Readonly<Record<string, unknown>>;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly exclude: ReadonlyArray<ExcludedStackService>;
  readonly base: StackConfig;
}): StackConfig {
  const { projectConfig, projectEnvironment } = input;
  const excluded = new Set(input.exclude);
  const enabled = (params: {
    readonly envName: string;
    readonly configured: boolean;
    readonly path: string;
    readonly excludedAs: ExcludedStackService;
  }) =>
    resolveBoolean({
      environment: projectEnvironment,
      envName: params.envName,
      configured: params.configured,
      path: params.path,
    }) && !excluded.has(params.excludedAs);

  const apiEnabled = enabled({
    envName: "SUPABASE_API_ENABLED",
    configured: projectConfig.api.enabled,
    path: "api.enabled",
    excludedAs: "postgrest",
  });
  const authEnabled = enabled({
    envName: "SUPABASE_AUTH_ENABLED",
    configured: projectConfig.auth.enabled,
    path: "auth.enabled",
    excludedAs: "auth",
  });
  const realtimeEnabled = enabled({
    envName: "SUPABASE_REALTIME_ENABLED",
    configured: projectConfig.realtime.enabled,
    path: "realtime.enabled",
    excludedAs: "realtime",
  });
  const storageEnabled = enabled({
    envName: "SUPABASE_STORAGE_ENABLED",
    configured: projectConfig.storage.enabled,
    path: "storage.enabled",
    excludedAs: "storage",
  });
  const mailpitEnabled = enabled({
    envName: "SUPABASE_LOCAL_SMTP_ENABLED",
    configured: projectConfig.local_smtp.enabled,
    path: "local_smtp.enabled",
    excludedAs: "mailpit",
  });
  const studioEnabled = enabled({
    envName: "SUPABASE_STUDIO_ENABLED",
    configured: projectConfig.studio.enabled,
    path: "studio.enabled",
    excludedAs: "studio",
  });
  const analyticsEnabled = enabled({
    envName: "SUPABASE_ANALYTICS_ENABLED",
    configured: projectConfig.analytics.enabled,
    path: "analytics.enabled",
    excludedAs: "analytics",
  });
  const poolerEnabled = enabled({
    envName: "SUPABASE_DB_POOLER_ENABLED",
    configured: projectConfig.db.pooler.enabled,
    path: "db.pooler.enabled",
    excludedAs: "pooler",
  });
  const edgeRuntimeEnabled = enabled({
    envName: "SUPABASE_EDGE_RUNTIME_ENABLED",
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
      environment: projectEnvironment,
      envName: "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
      configured: projectConfig.storage.image_transformation?.enabled ?? false,
      path: "storage.image_transformation.enabled",
    });

  const apiPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_API_PORT",
    configured: projectConfig.api.port,
    path: "api.port",
    required: apiEnabled,
  });
  const dbPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_DB_PORT",
    configured: projectConfig.db.port,
    path: "db.port",
    required: true,
  });
  const studioPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_STUDIO_PORT",
    configured: projectConfig.studio.port,
    path: "studio.port",
    required: studioEnabled,
  });
  const mailpitPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_LOCAL_SMTP_PORT",
    configured: projectConfig.local_smtp.port,
    path: "local_smtp.port",
    required: mailpitEnabled,
  });
  const mailpitSmtpPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_LOCAL_SMTP_SMTP_PORT",
    configured: projectConfig.local_smtp.smtp_port,
    path: "local_smtp.smtp_port",
  });
  const mailpitPop3Port = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_LOCAL_SMTP_POP3_PORT",
    configured: projectConfig.local_smtp.pop3_port,
    path: "local_smtp.pop3_port",
  });
  const analyticsPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_ANALYTICS_PORT",
    configured: projectConfig.analytics.port,
    path: "analytics.port",
    required: analyticsEnabled,
  });
  const poolerPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_DB_POOLER_PORT",
    configured: projectConfig.db.pooler.port,
    path: "db.pooler.port",
    required: poolerEnabled,
  });
  const edgeRuntimeInspectorPort = resolvePort({
    environment: projectEnvironment,
    envName: "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
    configured: projectConfig.edge_runtime.inspector_port,
    path: "edge_runtime.inspector_port",
  });

  return {
    ...input.base,
    port: apiPort,
    postgres: serviceConfig(input.base.postgres, { port: dbPort }),
    postgrest: apiEnabled
      ? serviceConfig(input.base.postgrest, {
          schemas: projectConfig.api.schemas,
          extraSearchPath: projectConfig.api.extra_search_path,
          maxRows: projectConfig.api.max_rows,
        })
      : false,
    auth: authEnabled ? serviceConfig(input.base.auth, {}) : false,
    edgeRuntime: edgeRuntimeEnabled
      ? serviceConfig(input.base.edgeRuntime, {
          policy: resolveEdgeRuntimePolicy(projectConfig.edge_runtime.policy),
          inspectorPort: edgeRuntimeInspectorPort,
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
          ...(mailpitSmtpPort === undefined ? {} : { smtpPort: mailpitSmtpPort }),
          ...(mailpitPop3Port === undefined ? {} : { pop3Port: mailpitPop3Port }),
          adminEmail: environmentOverride(
            "SUPABASE_LOCAL_SMTP_ADMIN_EMAIL",
            projectConfig.local_smtp.admin_email,
            projectEnvironment,
          ),
          senderName: environmentOverride(
            "SUPABASE_LOCAL_SMTP_SENDER_NAME",
            projectConfig.local_smtp.sender_name,
            projectEnvironment,
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
                "SUPABASE_STUDIO_API_URL",
                projectConfig.studio.api_url,
                projectEnvironment,
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
