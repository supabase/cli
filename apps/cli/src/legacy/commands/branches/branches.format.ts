import type {
  ApiKeyResponse,
  BranchResponse,
  SupavisorConfigResponse,
  V1GetABranchConfigOutput,
} from "@supabase/api/effect";

import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";
import { apiKeysToEnv } from "../../shared/legacy-api-keys.format.ts";
import { formatLegacyTimestamp } from "../../shared/legacy-timestamp.format.ts";

// ---------------------------------------------------------------------------
// Pure formatters — no Effect / no service dependencies, kept unit-testable.
// Match the established byte output for `branches list`, `branches create`,
// `branches get`.
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

type Branch = typeof BranchResponse.Type;

/**
 * Established markdown-table-to-glamour render pipeline: the markdown
 * intermediate wraps each cell in backticks and escapes `|` with `\|`;
 * glamour decodes the escape sequence back to a literal `|` and strips the
 * backticks. `renderGlamourTable` lays out cells directly, so raw values are
 * passed through — including any literal `|` in the name / git branch — and
 * the byte output matches the established fixture.
 *
 * `activeRef`, when given, marks the row whose `project_ref` matches by
 * rendering its NAME cell as `<name> (active)` — mirroring the `next/` shell's
 * convention (`next/commands/branches/list/list.handler.ts`). TS-only QoL
 * (CLI-2167 follow-up, no Go counterpart): the pretty table only, never the
 * `-o json|yaml|toml` / `--output-format json|stream-json` payloads.
 */
export function renderBranchesListTable(
  branches: ReadonlyArray<Branch>,
  activeRef?: string,
): string {
  const rows = branches.map((b) => [
    b.project_ref,
    b.project_ref === activeRef ? `${b.name} (active)` : b.name,
    b.is_default ? "true" : "false",
    b.git_branch ?? " ",
    b.with_data ? "true" : "false",
    b.status,
    formatLegacyTimestamp(b.created_at),
    formatLegacyTimestamp(b.updated_at),
  ]);
  return renderGlamourTable(LIST_HEADERS, rows);
}

/**
 * Pretty-table render: one row with 7 columns. `db_user` / `db_pass` /
 * `jwt_secret` render as `******` when the API returns nil/undefined.
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

// Standard-env projection for `branches get` non-pretty modes.

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
 * Removes the `[YOUR-PASSWORD]` placeholder text from the connection string
 * (it confuses pgconn's strict URL parser) and then parses the host/port/user.
 *
 * On failure, returns a structured result with the parse error description —
 * not the raw connection string. The established WARNING line carries the
 * pgconn parse error message (e.g. `failed to parse pooler URL: parse "...":
 * invalid port`), never the URL itself. Returning the URL would leak the
 * pooler username, host, and port into stderr logs.
 *
 * This display-only parser intentionally does not enforce the profile-domain or
 * tenant-ref guards used by `legacyPoolerConfigFromConnectionString`.
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
 * Established URL shape:
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

export interface StandardEnvsResult {
  readonly envs: Record<string, string>;
  /**
   * Set when the pooler URL failed to parse, so the caller can print the
   * established `fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)` line.
   */
  readonly poolerWarning?: string;
}

/**
 * Standard-env projection:
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
