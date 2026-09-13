/**
 * Builds the {@link StartContainerSpec} for the Postgres container both `supabase start` and
 * `db start`'s native container bootstrap use, including `db start`'s `fromBackup`
 * entrypoint/bind override.
 *
 * Out of scope: initial schema bootstrap, and creating/starting the container and waiting for
 * it to become healthy — see {@link createContainer} and {@link waitForHealthyServices}.
 */

import type { CliConfig } from "@supabase/config";

import { localDbContainerId } from "../docker-ids.ts";
import { toDockerMountPath } from "../docker-path.ts";
import { encodeToml } from "../go-output.encoders.ts";
import { POSTGRES_DEFAULT_ROOT_KEY } from "../local-config-values.ts";
import type { StartContainerSpec } from "./docker-create-args.ts";
import { START_DB_RESTORE_SH } from "./templates/db-restore.sh.ts";
import { START_DB_SCHEMA_SQL } from "./templates/db-schema.sql.ts";
import { START_DB_SUPABASE_SQL } from "./templates/db-supabase.sql.ts";
import { START_DB_WEBHOOK_SQL } from "./templates/db-webhook.sql.ts";

/**
 * The default database password. `[db] password` in config.toml is a TS-only extension — see
 * `buildShadowPostgresContainerSpec`'s `password` field below.
 */
const POSTGRES_PASSWORD = "postgres";

/**
 * In-container path for the pgsodium root key, delivered via
 * {@link buildPostgresStartContainerSpec}'s `secretFiles` docker cp rather than a heredoc.
 */
const POSTGRES_PGSODIUM_ROOT_KEY_PATH = "/etc/postgresql-custom/pgsodium_root.key";

/**
 * The post-migration hook path: `supabase/postgres`'s bundled `migrate.sh` execs
 * `psql -v ON_ERROR_STOP=1 -U supabase_admin -f /etc/postgresql.schema.sql` as its last step
 * when the file exists; {@link postgresEntrypointScriptPg15} heredocs it into place.
 */
const POSTGRES_SCHEMA_SQL_PATH = "/etc/postgresql.schema.sql";

/** Healthcheck timing constants. */
const POSTGRES_HEALTHCHECK_INTERVAL_SECONDS = 10;
const POSTGRES_HEALTHCHECK_TIMEOUT_SECONDS = 2;
const POSTGRES_HEALTHCHECK_RETRIES = 3;

/** The docker.io image's healthcheck: `pg_isready` alone is a sufficient readiness probe. */
const POSTGRES_HEALTHCHECK_TEST: ReadonlyArray<string> = [
  "CMD",
  "pg_isready",
  "-U",
  "postgres",
  "-h",
  "127.0.0.1",
  "-p",
  "5432",
];

/** Docker network aliases for the Postgres container. */
const POSTGRES_NETWORK_ALIASES: ReadonlyArray<string> = ["db", "db.supabase.internal"];

/** Version threshold below which `POSTGRES_INITDB_ARGS` gets a `--lc-collate=C.UTF-8` override. */
const POSTGRES_INITDB_VERSION_THRESHOLD = "15.8.1.005";

const POSTGRES_CONFIG_HEADER = "\n# supabase [db.settings] configuration\n";

export interface PostgresStartServiceInput {
  /** Decoded `[db]` section: `port`, `major_version`, and `settings`. */
  readonly db: CliConfig["db"];
  /** Decoded `[experimental]` section — only the OrioleDB/S3 fields are read. */
  readonly experimental: CliConfig["experimental"];
  /** Resolved `auth.jwt_secret`, as produced by `resolveLocalConfigValues`. */
  readonly jwtSecret: string;
  /** `config.auth.jwt_expiry`. */
  readonly jwtExpiry: number;
  /** Already sanitized — see `serviceContainerName`'s doc comment. */
  readonly projectId: string;
  /** The local stack's Docker network id. */
  readonly networkId: string;
  /** Already resolved/pulled (see `./image-prepull.ts`) — the container's own image. */
  readonly image: string;
  /**
   * `image` before registry resolution. The version-tag comparison in
   * {@link postgresImageVersionTag} runs against this un-rewritten value, since a
   * `SUPABASE_INTERNAL_IMAGE_REGISTRY` override containing a port would otherwise inject an
   * extra colon that breaks the tag split.
   */
  readonly configImage: string;
  /** Already-resolved `db.root_key`. Defaults to {@link POSTGRES_DEFAULT_ROOT_KEY} when omitted. */
  readonly rootKey?: string;
  /**
   * Absolute host path to a `--from-backup` logical-dump file, already resolved against the
   * caller's cwd (only `db start` sets it). Switches to {@link postgresEntrypointScriptRestore}
   * regardless of `db.major_version` and appends a `<hostPath>:/etc/backup.sql:ro` bind.
   */
  readonly fromBackup?: string;
}

/**
 * Serializes `db.settings` as TOML: only the fields actually set, with `"` replaced by `'`, and
 * the fixed header comment prepended. The empty-settings case is special-cased rather than
 * delegated to {@link encodeToml}, since it always appends a trailing newline even for an
 * empty object.
 */
export function postgresSettingsToPostgresConfig(settings: CliConfig["db"]["settings"]): string {
  const defined = Object.fromEntries(
    Object.entries(settings ?? {}).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
  if (Object.keys(defined).length === 0) {
    return POSTGRES_CONFIG_HEADER;
  }
  const toml = encodeToml(defined).replaceAll('"', "'");
  return `${POSTGRES_CONFIG_HEADER}${toml}`;
}

/**
 * Compares dotted version strings, not a full semver comparator: the first 3 components are
 * the primary key, and any remaining components (joined, left-trimmed of leading zeros) break
 * ties. An invalid version string sorts before a valid one; two invalid strings compare equal.
 */
export function postgresVersionCompare(a: string, b: string): number {
  const [aHead, aTail] = splitVersionHeadTail(a);
  const [bHead, bTail] = splitVersionHeadTail(b);
  const headCompare = compareVersionStrings(aHead, bHead);
  if (headCompare !== 0) return headCompare;
  return compareVersionStrings(aTail, bTail);
}

function splitVersionHeadTail(version: string): readonly [string, string] {
  const parts = version.split(".");
  if (parts.length <= 3) return [version, ""];
  return [parts.slice(0, 3).join("."), parts.slice(3).join(".").replace(/^0+/, "")];
}

function isValidDottedVersion(version: string): boolean {
  return version.length > 0 && version.split(".").every((part) => /^\d+$/.test(part));
}

function compareVersionStrings(a: string, b: string): number {
  const aValid = isValidDottedVersion(a);
  const bValid = isValidDottedVersion(b);
  if (!aValid || !bValid) {
    return aValid === bValid ? 0 : aValid ? 1 : -1;
  }
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The first colon splits an image reference's name from its tag. The caller must pass the
 * pre-registry-rewrite image (see {@link PostgresStartServiceInput.configImage}) — a resolved
 * image can carry a registry host prefix with its own colon (e.g.
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY=localhost:5000`), which would otherwise be misparsed as the
 * tag. Returns the whole string when no colon is present.
 */
export function postgresImageVersionTag(image: string): string {
  const colonIndex = image.indexOf(":");
  return colonIndex === -1 ? image : image.slice(colonIndex + 1);
}

/**
 * OrioleDB/S3 env overrides take priority; otherwise falls back to the collate-locale override
 * for images older than {@link POSTGRES_INITDB_VERSION_THRESHOLD}. At most one branch fires.
 */
function postgresExtraEnv(
  experimental: CliConfig["experimental"],
  image: string,
): Readonly<Record<string, string>> {
  if (experimental.orioledb_version !== undefined && experimental.orioledb_version.length > 0) {
    return {
      POSTGRES_INITDB_ARGS: "--lc-collate=C --lc-ctype=C",
      S3_ENABLED: "true",
      S3_HOST: experimental.s3_host ?? "",
      S3_REGION: experimental.s3_region ?? "",
      S3_ACCESS_KEY: experimental.s3_access_key ?? "",
      S3_SECRET_KEY: experimental.s3_secret_key ?? "",
    };
  }
  const tag = postgresImageVersionTag(image);
  if (postgresVersionCompare(tag, POSTGRES_INITDB_VERSION_THRESHOLD) < 0) {
    return { POSTGRES_INITDB_ARGS: "--lc-collate=C.UTF-8" };
  }
  return {};
}

/**
 * PG >= 15 entrypoint: writes `/etc/postgresql.schema.sql` (schema.sql + webhook.sql +
 * _supabase.sql, in that order), appends `postgresConfig` to `postgresql.conf`, then execs
 * `docker-entrypoint.sh`. The pgsodium root key travels via
 * {@link StartContainerSpec.secretFiles} (mode `0644`, since Postgres drops root and reads it
 * back as the `postgres` user) instead of an inline heredoc, so it never appears in this
 * process's own `docker create` argv.
 *
 * The command is `exec`'d so Postgres becomes PID 1 and stops on SIGTERM in about a second
 * instead of waiting out the full stop grace period. Built via string concatenation, not a
 * template literal, so a trailing space after `/etc/postgresql` (when `args` is empty) stays a
 * visible character.
 */
function postgresEntrypointScriptPg15(postgresConfig: string, args = ""): string {
  return (
    "\n" +
    `cat <<'EOF' > ${POSTGRES_SCHEMA_SQL_PATH} && \\\n` +
    "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
    `exec docker-entrypoint.sh postgres -D /etc/postgresql ${args}\n` +
    `${START_DB_SCHEMA_SQL}\n` +
    `${START_DB_WEBHOOK_SQL}\n` +
    `${START_DB_SUPABASE_SQL}\n` +
    "EOF\n" +
    `${postgresConfig}\n` +
    "EOF"
  );
}

/**
 * PG <= 14 entrypoint: a shorter script — no `schema.sql`/`webhook.sql` (PG >= 15 only) and no
 * pgsodium root key file — writes `/docker-entrypoint-initdb.d/supabase_schema.sql`
 * (_supabase.sql only), appends `postgresConfig` to `postgresql.conf`, then execs
 * `docker-entrypoint.sh`. See {@link postgresEntrypointScriptPg15} for the `args` parameter
 * and string-concatenation rationale.
 */
function postgresEntrypointScriptPg14(postgresConfig: string, args = ""): string {
  return (
    "\n" +
    "cat <<'EOF' > /docker-entrypoint-initdb.d/supabase_schema.sql && \\\n" +
    "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
    `exec docker-entrypoint.sh postgres -D /etc/postgresql ${args}\n` +
    `${START_DB_SUPABASE_SQL}\n` +
    "EOF\n" +
    `${postgresConfig}\n` +
    "EOF"
  );
}

/**
 * `--from-backup` entrypoint, applied regardless of `db.major_version`. Three heredocs, not
 * four: the pgsodium root key still travels via {@link StartContainerSpec.secretFiles} (see
 * {@link buildPostgresStartContainerSpec}), same as the other entrypoint variants. The schema
 * heredoc omits the webhook schema present in {@link postgresEntrypointScriptPg15}. Postgres
 * config gets one extra appended line, `cron.launch_active_jobs = off`.
 */
function postgresEntrypointScriptRestore(postgresConfig: string): string {
  return (
    "\n" +
    `cat <<'EOF' > ${POSTGRES_SCHEMA_SQL_PATH} && \\\n` +
    "cat <<'EOF' > /docker-entrypoint-initdb.d/migrate.sh && \\\n" +
    "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
    "exec docker-entrypoint.sh postgres -D /etc/postgresql\n" +
    `${START_DB_SCHEMA_SQL}\n` +
    `${START_DB_SUPABASE_SQL}\n` +
    "EOF\n" +
    `${START_DB_RESTORE_SH}\n` +
    "EOF\n" +
    `${postgresConfig}\n` +
    "cron.launch_active_jobs = off\n" +
    "EOF"
  );
}

/**
 * Builds the {@link StartContainerSpec} for the Postgres container — shared by `supabase
 * start` (never sets {@link PostgresStartServiceInput.fromBackup}) and `db start`'s native
 * bootstrap (the only caller that does). See this module's header for what's out of scope.
 */
export function buildPostgresStartContainerSpec(
  input: PostgresStartServiceInput,
): StartContainerSpec {
  const containerName = localDbContainerId(input.projectId);
  const rootKeyValue = input.rootKey ?? POSTGRES_DEFAULT_ROOT_KEY;
  const postgresConfig = postgresSettingsToPostgresConfig(input.db.settings);
  const isPg14OrEarlier = input.db.major_version <= 14;
  const isRestore = input.fromBackup !== undefined;

  const env: Record<string, string> = {
    // Always the literal "postgres" password; `buildShadowPostgresContainerSpec` below threads
    // a config-derived password instead. If this container ever honors `[db] password` too,
    // both must change together.
    POSTGRES_PASSWORD: POSTGRES_PASSWORD,
    POSTGRES_HOST: "/var/run/postgresql",
    JWT_SECRET: input.jwtSecret,
    JWT_EXP: String(input.jwtExpiry),
    ...postgresExtraEnv(input.experimental, input.configImage),
  };

  const script = isRestore
    ? postgresEntrypointScriptRestore(postgresConfig)
    : isPg14OrEarlier
      ? postgresEntrypointScriptPg14(postgresConfig)
      : postgresEntrypointScriptPg15(postgresConfig);

  return {
    image: input.image,
    containerName,
    env,
    entrypoint: "sh",
    cmd: ["-c", script],
    // The pgsodium root key secretFile is present whenever the entrypoint in use embeds it:
    // both the PG >= 15 and restore scripts do; only the PG <= 14 script never references it.
    ...(isPg14OrEarlier && !isRestore
      ? {}
      : {
          secretFiles: [{ containerPath: POSTGRES_PGSODIUM_ROOT_KEY_PATH, content: rootKeyValue }],
        }),
    binds: [
      `${containerName}:/var/lib/postgresql/data`,
      // The backup file bind is appended only on the `fromBackup` branch.
      ...(input.fromBackup === undefined
        ? []
        : [`${toDockerMountPath(input.fromBackup)}:/etc/backup.sql:ro`]),
    ],
    // Tmpfs is keyed on `isPg14OrEarlier` alone, independent of `isRestore`.
    ...(isPg14OrEarlier ? { tmpfs: { "/docker-entrypoint-initdb.d": "" } } : {}),
    ports: [{ hostPort: String(input.db.port), containerPort: "5432" }],
    healthcheck: {
      test: POSTGRES_HEALTHCHECK_TEST,
      intervalSeconds: POSTGRES_HEALTHCHECK_INTERVAL_SECONDS,
      timeoutSeconds: POSTGRES_HEALTHCHECK_TIMEOUT_SECONDS,
      retries: POSTGRES_HEALTHCHECK_RETRIES,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: POSTGRES_NETWORK_ALIASES,
    labels: {},
  };
}

/** Shadow entrypoint arg splice that disables background workers. */
export const SHADOW_ENTRYPOINT_ARGS = "-c max_worker_processes=0";

/**
 * Input to {@link buildShadowPostgresContainerSpec}: the subset of
 * {@link PostgresStartServiceInput} the shadow variant needs (no `projectId`/`fromBackup`,
 * since the shadow container has no name and never restores from a backup) plus its own host port.
 */
export interface ShadowPostgresContainerSpecInput {
  readonly db: Pick<CliConfig["db"], "major_version" | "settings">;
  readonly experimental: CliConfig["experimental"];
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly networkId: string;
  readonly image: string;
  readonly configImage: string;
  readonly rootKey?: string;
  /** The shadow's own host port, published to `5432/tcp` in-container. */
  readonly shadowPort: number;
  /**
   * `[db] password` (already resolved from `config.toml`, defaulting to `"postgres"` when
   * unset). Must match what {@link buildShadowPostgresContainerSpec}'s caller connects with —
   * a non-default `[db] password` would otherwise authenticate against the wrong secret.
   */
  readonly password: string;
}

/**
 * Builds the {@link StartContainerSpec} for the shadow database container: same image, env,
 * healthcheck, and entrypoint-script shape as the real `db` container (with
 * {@link SHADOW_ENTRYPOINT_ARGS} added), but ephemeral and unnamed. It still joins the network
 * without aliases — Docker's embedded DNS resolves it by its auto-generated name and short
 * container id — and still carries labels, so `supabase stop`'s label-filtered sweep also
 * catches an orphaned shadow.
 */
export function buildShadowPostgresContainerSpec(
  input: ShadowPostgresContainerSpecInput,
): StartContainerSpec {
  const rootKeyValue = input.rootKey ?? POSTGRES_DEFAULT_ROOT_KEY;
  const postgresConfig = postgresSettingsToPostgresConfig(input.db.settings);
  const isPg14OrEarlier = input.db.major_version <= 14;

  const env: Record<string, string> = {
    POSTGRES_PASSWORD: input.password,
    POSTGRES_HOST: "/var/run/postgresql",
    JWT_SECRET: input.jwtSecret,
    JWT_EXP: String(input.jwtExpiry),
    ...postgresExtraEnv(input.experimental, input.configImage),
  };

  const script = isPg14OrEarlier
    ? postgresEntrypointScriptPg14(postgresConfig, SHADOW_ENTRYPOINT_ARGS)
    : postgresEntrypointScriptPg15(postgresConfig, SHADOW_ENTRYPOINT_ARGS);

  return {
    image: input.image,
    containerName: "",
    env,
    entrypoint: "sh",
    cmd: ["-c", script],
    ...(isPg14OrEarlier
      ? {}
      : {
          secretFiles: [{ containerPath: POSTGRES_PGSODIUM_ROOT_KEY_PATH, content: rootKeyValue }],
        }),
    binds: [],
    autoRemove: true,
    ...(isPg14OrEarlier ? { tmpfs: { "/docker-entrypoint-initdb.d": "" } } : {}),
    ports: [{ hostPort: String(input.shadowPort), containerPort: "5432" }],
    healthcheck: {
      test: POSTGRES_HEALTHCHECK_TEST,
      intervalSeconds: POSTGRES_HEALTHCHECK_INTERVAL_SECONDS,
      timeoutSeconds: POSTGRES_HEALTHCHECK_TIMEOUT_SECONDS,
      retries: POSTGRES_HEALTHCHECK_RETRIES,
    },
    networkId: input.networkId,
    labels: {},
  };
}
