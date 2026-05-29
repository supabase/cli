import type {
  ApiKeyResponse,
  BranchResponse,
  SupavisorConfigResponse,
  V1GetABranchConfigOutput,
} from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";

// ---------------------------------------------------------------------------
// Pure formatters — no Effect / no service dependencies, kept unit-testable.
// Match Go's byte output for `branches list`, `branches create`, `branches get`.
// ---------------------------------------------------------------------------

const LIST_HEADERS = [
  "ID",
  "NAME",
  "DEFAULT",
  "GIT BRANCH",
  "WITH DATA",
  "STATUS",
  "CREATED AT (UTC)",
  "UPDATED AT (UTC)",
] as const;

const GET_HEADERS = [
  "HOST",
  "PORT",
  "USER",
  "PASSWORD",
  "JWT SECRET",
  "POSTGRES VERSION",
  "STATUS",
] as const;

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Reproduces Go's `utils.FormatTime`: parse the ISO date-time and re-render
 * as UTC "YYYY-MM-DD HH:MM:SS". Used for the CREATED AT / UPDATED AT columns
 * of `branches list`.
 */
export function formatUtcDateTime(value: string): string {
  if (value.length === 0) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const d = new Date(parsed);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

type Branch = typeof BranchResponse.Type;

/**
 * Reproduces Go's `branches/list/list.go:ToMarkdown` + glamour pipeline.
 *
 * Go's markdown intermediate wraps each cell in backticks and escapes `|`
 * with `\|`; glamour decodes the escape sequence back to a literal `|` and
 * strips the backticks. Our `renderGlamourTable` lays out cells directly,
 * so we pass raw values — including any literal `|` in the name / git branch
 * — and the byte output matches the Go binary fixture.
 */
export function renderBranchesListTable(branches: ReadonlyArray<Branch>): string {
  const rows = branches.map((b) => [
    b.project_ref,
    b.name,
    b.is_default ? "true" : "false",
    b.git_branch ?? " ",
    b.with_data ? "true" : "false",
    b.status,
    formatUtcDateTime(b.created_at),
    formatUtcDateTime(b.updated_at),
  ]);
  return renderGlamourTable(LIST_HEADERS, rows);
}

/**
 * Reproduces Go's `branches/get/get.go:38-51` pretty-table render: one row
 * with 7 columns. `db_user` / `db_pass` / `jwt_secret` render as `******`
 * when the API returns nil/undefined (matches Go's `if x == nil { x = &"******" }`
 * mutation in `get.go:71-80`).
 */
export function renderBranchGetTable(detail: typeof V1GetABranchConfigOutput.Type): string {
  const rows = [
    [
      detail.db_host,
      String(detail.db_port),
      detail.db_user ?? "******",
      detail.db_pass ?? "******",
      detail.jwt_secret ?? "******",
      detail.postgres_version,
      detail.status,
    ],
  ];
  return renderGlamourTable(GET_HEADERS, rows);
}

// ---------------------------------------------------------------------------
// Standard-env projection for `branches get` non-pretty modes.
// Mirrors Go's `toStandardEnvs` + `apiKeys.ToEnv` (`get.go:84-105`,
// `api_keys.go:51-66`).
// ---------------------------------------------------------------------------

const POOLER_PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]";

interface PoolerParts {
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly runtimeParams: Readonly<Record<string, string>>;
}

export type PoolerParseResult =
  | { readonly ok: true; readonly parts: PoolerParts }
  | { readonly ok: false; readonly error: string };

/**
 * Reproduces Go's `utils.ParsePoolerURL` (`apps/cli-go/internal/utils/connect.go:103`):
 * remove the `[YOUR-PASSWORD]` placeholder text from the connection string
 * (it confuses pgconn's strict URL parser) and then parse the host/port/user.
 *
 * On failure, returns a structured result with the parse error description —
 * not the raw connection string. Go's WARNING line carries the pgconn parse
 * error message (e.g. `failed to parse pooler URL: parse "...": invalid port`),
 * never the URL itself. Returning the URL would leak the pooler username,
 * host, and port into stderr logs.
 */
export function parsePoolerConnectionString(connString: string): PoolerParseResult {
  const sanitized = connString.replaceAll(POOLER_PASSWORD_PLACEHOLDER, "");
  let url: URL;
  try {
    url = new URL(sanitized);
  } catch {
    // Node's URL constructor embeds the input string in its error message.
    // Return a stable description with no input fragments so the warning
    // line on stderr never leaks the pooler URL.
    return { ok: false, error: "invalid URL" };
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return { ok: false, error: `unexpected scheme ${url.protocol}` };
  }
  const port = Number.parseInt(url.port || "5432", 10);
  if (Number.isNaN(port)) {
    return { ok: false, error: `invalid port ${url.port}` };
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "") || "postgres");
  const runtimeParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    runtimeParams[key] = value;
  });
  return {
    ok: true,
    parts: {
      user: decodeURIComponent(url.username),
      host: url.hostname,
      port,
      database,
      runtimeParams,
    },
  };
}

interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly runtimeParams?: Readonly<Record<string, string>>;
}

/**
 * Reproduces Go's `utils.ToPostgresURL` (`apps/cli-go/internal/utils/connect.go:23`):
 *
 *   postgresql://<urlencode(user):urlencode(pass)>@<host>:<port>/<pathEscape(db)>?connect_timeout=10[&k=urlencode(v)]
 *
 * IPv6 hosts get wrapped in square brackets. ConnectTimeout defaults to 10.
 */
export function toPostgresUrl(config: PgConfig, connectTimeoutSeconds: number = 10): string {
  const params = new URLSearchParams();
  params.set("connect_timeout", String(connectTimeoutSeconds));
  for (const [k, v] of Object.entries(config.runtimeParams ?? {})) {
    params.append(k, v);
  }
  let host = config.host;
  // IPv6 detection: contains `:` and isn't already bracketed.
  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }
  return (
    `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}` +
    `@${host}:${config.port}/${encodeURIComponent(config.database)}?${params.toString()}`
  );
}

type ApiKey = typeof ApiKeyResponse.Type;
type Pooler = typeof SupavisorConfigResponse.Type;
type Detail = typeof V1GetABranchConfigOutput.Type;

/**
 * Reproduces Go's `apiKeys.ToEnv` (`api_keys.go:51-66`):
 * uppercase the name, wrap as `SUPABASE_<NAME>_KEY`, fall back to `"******"`
 * when the api_key value is nullable-null.
 */
export function apiKeysToEnv(keys: ReadonlyArray<ApiKey>): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const entry of keys) {
    const name = entry.name.toUpperCase();
    const key = `SUPABASE_${name}_KEY`;
    const value = entry.api_key === undefined || entry.api_key === null ? "******" : entry.api_key;
    envs[key] = value;
  }
  return envs;
}

export interface StandardEnvsResult {
  readonly envs: Record<string, string>;
  /**
   * Set when the pooler URL failed to parse, so the caller can mirror Go's
   * `fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)` line.
   */
  readonly poolerWarning?: string;
}

/**
 * Reproduces Go's `toStandardEnvs` (`apps/cli-go/internal/branches/get/get.go:84-105`):
 *
 *   - `POSTGRES_URL`: pooled URL on success, falls back to the direct URL with
 *     a stderr warning on parse failure.
 *   - `POSTGRES_URL_NON_POOLING`: direct URL.
 *   - `SUPABASE_URL`: `https://<projectRef>.<projectHost>`.
 *   - `SUPABASE_JWT_SECRET`: the unmasked secret (which has already been
 *     `******`-substituted upstream if the API returned null).
 *   - `SUPABASE_<NAME>_KEY`: from `apiKeysToEnv`.
 */
export function toStandardEnvs(
  detail: Detail,
  pooler: Pooler,
  keys: ReadonlyArray<ApiKey>,
  projectHost: string,
): StandardEnvsResult {
  const direct: PgConfig = {
    host: detail.db_host,
    port: detail.db_port,
    user: detail.db_user ?? "******",
    password: detail.db_pass ?? "******",
    database: "postgres",
  };

  let poolerWarning: string | undefined;
  let pooled: PgConfig = direct;
  const parsed = parsePoolerConnectionString(pooler.connection_string);
  if (!parsed.ok) {
    poolerWarning = `failed to parse pooler URL: ${parsed.error}`;
  } else {
    pooled = {
      host: parsed.parts.host,
      port: parsed.parts.port,
      user: parsed.parts.user,
      password: direct.password,
      database: parsed.parts.database,
      runtimeParams: parsed.parts.runtimeParams,
    };
  }

  const envs: Record<string, string> = {
    ...apiKeysToEnv(keys),
    POSTGRES_URL: toPostgresUrl(pooled),
    POSTGRES_URL_NON_POOLING: toPostgresUrl(direct),
    SUPABASE_URL: `https://${detail.ref}.${projectHost}`,
    SUPABASE_JWT_SECRET: detail.jwt_secret ?? "******",
  };

  return poolerWarning === undefined ? { envs } : { envs, poolerWarning };
}
