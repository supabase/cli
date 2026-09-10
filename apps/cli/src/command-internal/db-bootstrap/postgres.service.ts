/**
 * Builds the {@link StartContainerSpec} for the Postgres container both `supabase start` and
 * `db start`'s native container bootstrap use, including `db start`'s `fromBackup`
 * entrypoint/bind override.
 *
 * Out of scope: initial schema bootstrap, and actually creating/starting the container and
 * waiting for it to become healthy — see {@link createContainer} and
 * {@link waitForHealthyServices}, wired up by each caller's own handler.
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
 * `psql -v ON_ERROR_STOP=1 -U supabase_admin -f /etc/postgresql.schema.sql` as
 * its last step when the file exists. The docker.io entrypoint heredocs it
 * (see {@link postgresEntrypointScriptPg15}).
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
   * `image` before registry resolution: the version-tag comparison in
   * {@link postgresImageVersionTag} always runs against this un-rewritten value, since a
   * `SUPABASE_INTERNAL_IMAGE_REGISTRY` override containing a port would otherwise inject an
   * extra colon that breaks the tag split.
   */
  readonly configImage: string;
  /** Already-resolved `db.root_key`. Defaults to {@link POSTGRES_DEFAULT_ROOT_KEY} when omitted. */
  readonly rootKey?: string;
  /**
   * Absolute host path to a `--from-backup` logical-dump file, already resolved against the
   * caller's cwd. `db start`'s only caller. When set, switches to
   * {@link postgresEntrypointScriptRestore} regardless of `db.major_version` and appends a
   * `<hostPath>:/etc/backup.sql:ro` bind. `undefined` for `supabase start`.
   */
  readonly fromBackup?: string;
}

/**
 * Serializes `db.settings` as TOML: only the fields actually set, with `"` replaced by `'`, and
 * the fixed header comment prepended.
 *
 * The empty-settings case is special-cased rather than delegated to {@link encodeToml}, since
 * `encodeToml` always appends a trailing newline even for an empty object.
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
 * Port of Go's `config.VersionCompare` (`apps/cli-go/pkg/config/config.go:885-899`)
 * — NOT a real semver comparator. A dotted version with more than 3 components
 * truncates to its first 3 as the primary comparison key, and compares the
 * remaining components — joined and left-trimmed of leading `0` characters —
 * as a secondary tie-break (Go: `semver.Compare("v"+pA, "v"+pB)`). Both real
 * inputs at this module's one call site (a Postgres image tag and the
 * `"15.8.1.005"` threshold) always have exactly 4 numeric components, so this
 * only reproduces Go's `golang.org/x/mod/semver` invalid-version rule (an
 * invalid version string sorts before a valid one; two invalid strings
 * compare equal — exercised by Go's own `TestVersionCompare` `"oriole-17"`
 * cases) for the narrower set of shapes real inputs can take; full semver
 * pre-release/build-metadata syntax is out of scope.
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
 * Go's `i := strings.IndexByte(utils.Config.Db.Image, ':'); ...Image[i+1:]`
 * (`apps/cli-go/internal/db/start/start.go:79`) — the FIRST colon splits the
 * image name from its tag. Go's own `Db.Image` is never registry-prefixed at
 * this point in Go's pipeline (registry resolution only overwrites the
 * container's `Image` field afterward, inside `DockerStart` —
 * `docker.go:365,371`), so the first colon is always the name/tag separator.
 * The caller MUST pass the pre-registry-rewrite image (see
 * {@link PostgresStartServiceInput.configImage}) — a resolved image can
 * carry a registry host prefix with its own colon (e.g. a
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY=localhost:5000` override), which would
 * otherwise be misparsed as the tag. When no colon is present at all, Go's
 * slice expression degrades to the whole string (`Image[0:]`) — reproduced
 * here the same way.
 */
export function postgresImageVersionTag(image: string): string {
  const colonIndex = image.indexOf(":");
  return colonIndex === -1 ? image : image.slice(colonIndex + 1);
}

/**
 * Go's OrioleDB / version-compare `Env` branch (`start.go:70-81`) — an
 * `else if`, so at most one of the two ever fires.
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
 * PG >= 15 entrypoint (`config.db.major_version > 14`, Go's default branch,
 * `start.go:91-104`): writes `/etc/postgresql.schema.sql` (schema.sql +
 * webhook.sql + _supabase.sql, concatenated in that exact order), appends
 * `postgresConfig` to `postgresql.conf`, then execs `docker-entrypoint.sh`.
 * Go also heredocs `/etc/postgresql-custom/pgsodium_root.key` directly into
 * this same script (`start.go:96`) — safe for Go, which calls
 * `Docker.ContainerCreate` over the Engine API directly rather than shelling
 * out. THIS PORT SHELLS OUT to a real `docker create`, so it deliberately
 * diverges here: the pgsodium root key travels via
 * {@link StartContainerSpec.secretFiles} instead (an in-memory tar
 * entry, mode `0644` — world-readable, because Postgres's entrypoint drops
 * root and reads this file back as the `postgres` user; see
 * `copyStartSecretFilesIntoContainer`'s doc comment — streamed via
 * `docker cp - <id>:/` straight into the container at that exact path — see
 * {@link buildPostgresStartContainerSpec}), so it never appears in this
 * process's own `docker create` argv (CWE-214/522).
 *
 * The final command is `exec`'d — a deliberate divergence from Go's script
 * (which leaves `sh` as PID 1, so SIGTERM is never forwarded and every
 * `docker stop` burns the full 10s grace period before SIGKILL; with `exec`,
 * Postgres is PID 1 and stops in ~1s). Applies to all three entrypoint
 * variants below. Timing is not part of the Go-parity surface (ADR 0016);
 * see `shadow-cache.ts`'s own doc comment for why fast shutdown matters to the shadow baseline
 * cache's cold path.
 *
 * Otherwise byte-for-byte derived from Go's raw-string concatenation —
 * `NewContainerConfig(args ...string)` splices `strings.Join(args, " ")`
 * straight after the literal trailing space following `/etc/postgresql`
 * (`start.go:95`): `supabase start`'s own Postgres container always calls it
 * with zero args (`args` here defaults to `""`, so the trailing space
 * survives on its own, unchanged from before), while the shadow-database
 * variant (`CreateShadowDatabase`, `apps/cli-go/internal/db/diff/diff.go:140`)
 * passes {@link SHADOW_ENTRYPOINT_ARGS} — see
 * {@link buildShadowPostgresContainerSpec}. Built via explicit
 * `"...\n" +` concatenation rather than a multi-line template literal so that
 * the trailing space (when `args` is empty) stays a visible, lint/format-proof
 * string character instead of invisible end-of-line whitespace.
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
 * PG <= 14 entrypoint (`start.go:106-113`): a shorter script — no
 * `schema.sql`/`webhook.sql` (PG >= 15 only) and no pgsodium root key file —
 * writes `/docker-entrypoint-initdb.d/supabase_schema.sql` (_supabase.sql
 * only), appends `postgresConfig` to `postgresql.conf`, then execs
 * `docker-entrypoint.sh`. See {@link postgresEntrypointScriptPg15}'s doc
 * comment for why this is explicit concatenation rather than a template
 * literal, and for the `args` parameter (same trailing-space splice, same
 * default).
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
 * `--from-backup` entrypoint (`StartDatabase`'s unconditional `Entrypoint` override,
 * `start.go:143-159`) — applies regardless of `db.major_version`, unlike the two scripts above.
 * Three heredocs, not four: unlike Go's literal script (which heredocs the pgsodium root key
 * inline), this port always carries the root key via {@link StartContainerSpec.secretFiles}
 * instead (see {@link buildPostgresStartContainerSpec}'s call site) — an intentional,
 * pre-existing TS divergence for every entrypoint variant, not something to "fix toward Go" here.
 * Schema heredoc is `initialSchema + _supabaseSchema` — deliberately NO `webhookSchema` (present in
 * {@link postgresEntrypointScriptPg15}, absent here, matching Go's own
 * `` ` + initialSchema + ` ` + _supabaseSchema + ` `` with no `webhookSchema` splice in the
 * `fromBackup` branch). Postgres config gets one extra literal line appended,
 * `cron.launch_active_jobs = off`, matching Go's own trailing append.
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
 * start` (always {@link PostgresStartServiceInput.fromBackup} `undefined`) and `db start`'s
 * native bootstrap (the only caller that ever sets it) — see this module's header for what's
 * deliberately out of scope.
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
    // The constant `"postgres"` literal, matching Go, where `Db.Password` is
    // `toml:"-"` (never decoded from config.toml) and only ever holds the default
    // (`pkg/config/db.go:88`, `config.go:459`). The sibling shadow builder below
    // (`buildShadowPostgresContainerSpec`) instead threads a config-derived
    // `input.password` — a deliberate TS extension on the shadow path only; if this
    // container ever honors `[db] password` too, both must change together.
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
    // The pgsodium root key heredoc/bind is present whenever the ACTUAL entrypoint in use
    // embeds it: both `postgresEntrypointScriptPg15` and
    // `postgresEntrypointScriptRestore` do (Go's `fromBackup` override always re-adds
    // its own root-key heredoc, `start.go:147,155`, regardless of major version); only the
    // PG<=14 script never references it.
    ...(isPg14OrEarlier && !isRestore
      ? {}
      : {
          secretFiles: [{ containerPath: POSTGRES_PGSODIUM_ROOT_KEY_PATH, content: rootKeyValue }],
        }),
    binds: [
      `${containerName}:/var/lib/postgresql/data`,
      // Go's `StartDatabase` (`start.go:163`) appends this bind ONLY on the `fromBackup` branch —
      // `hostConfig.Binds` is otherwise built solely from `NewHostConfig()`'s own volume bind above.
      ...(input.fromBackup === undefined
        ? []
        : [`${toDockerMountPath(input.fromBackup)}:/etc/backup.sql:ro`]),
    ],
    // Go's `NewHostConfig()` sets `Tmpfs` purely off `db.major_version` (`start.go:127-129`) — that
    // check is NOT part of `StartDatabase`'s `fromBackup` override, so this stays keyed on
    // `isPg14OrEarlier` alone, independent of `isRestore`.
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

/**
 * Shadow `docker-entrypoint.sh postgres -D /etc/postgresql <args>` splice —
 * disables background workers (`CreateShadowDatabase`).
 */
export const SHADOW_ENTRYPOINT_ARGS = "-c max_worker_processes=0";

/**
 * Input to {@link buildShadowPostgresContainerSpec} — the subset of
 * {@link PostgresStartServiceInput} the shadow variant actually needs (no
 * `projectId`/`fromBackup`: the shadow container has no name and never restores from a
 * backup) plus the shadow's own host port.
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
  /** `utils.Config.Db.ShadowPort` — the shadow's own host port, published to `5432/tcp` in-container. */
  readonly shadowPort: number;
  /**
   * `[db] password` (already resolved from `config.toml`, `DEFAULT_DB_PASSWORD`/"postgres" when
   * unset). Honoring the toml key is a deliberate TS extension, NOT Go parity: Go's
   * `NewContainerConfig` does source `POSTGRES_PASSWORD` from `utils.Config.Db.Password` for both
   * the real container and the shadow (`CreateShadowDatabase` reuses it verbatim, `diff.go:140`),
   * but in Go that field is invariably the `"postgres"` default — `json:"-"` (`db.go:88`, the tag
   * viper decodes with, `config.go:749-750`) makes a literal `[db] password` key a fatal
   * `UnmarshalExact` config error, and blocks the env binding. The TS extension mirrors what
   * `--local` connections already do on develop (`db-config.layer.ts`). Must be threaded
   * through so the shadow's actual Postgres password matches what
   * `shadowRunInputFromLocalContainerInputs`'s caller connects with — otherwise a
   * non-default `[db] password` authenticates against the wrong secret.
   */
  readonly password: string;
}

/**
 * Builds the {@link StartContainerSpec} for the shadow database container. Port of
 * Go's `CreateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:138-151`) — reuses
 * the EXACT SAME `NewContainerConfig` (image/env/healthcheck/entrypoint-script shape) the
 * real local `db` container uses, just with {@link SHADOW_ENTRYPOINT_ARGS} spliced
 * into the entrypoint and a materially different `container.HostConfig`/networking:
 *
 *  - **Empty `containerName`** (Go passes `""` to `DockerStart`, letting Docker
 *    auto-generate one) — see {@link StartContainerSpec.containerName}'s own doc
 *    comment for how the arg-builder and secret-file staging handle this.
 *  - **`autoRemove: true`** — Go's `hostConfig.AutoRemove` (`--rm`).
 *  - **No volume bind** — the shadow is throwaway; Go's `hostConfig` sets no `Binds` at all.
 *  - **No `restartPolicy`** — Go's `hostConfig` sets no `RestartPolicy` either.
 *  - **No `networkAliases`** — Go's `networkingConfig` is a bare, empty
 *    `network.NetworkingConfig{}` (no `db`/`db.supabase.internal` aliases). The shadow
 *    still joins the network via `DockerStart`'s own default `NetworkMode` (confirmed
 *    empirically: Docker's embedded DNS resolves a container on a user-defined network by
 *    BOTH its auto-generated name and its 12-char short container id, with no alias
 *    needed — see `shadow-database.ts`'s header for why this matters).
 *  - **Tmpfs on PG <= 14 IS still applied** — same `isPg14OrEarlier` condition as the real
 *    `db` container.
 *  - **The pgsodium root key `secretFiles` entry is still applied on PG >= 15** — the
 *    shadow's entrypoint script is the SAME `postgresEntrypointScriptPg15`, which
 *    still heredocs it in Go (splice point unaffected by `args`), so this port still needs
 *    it delivered before `docker start` — via `docker cp` straight into the container
 *    (`container-lifecycle.ts`), same as every other container's `secretFiles`, never a
 *    host temp file.
 *  - **Labels ARE still applied** (merged in by `createContainer`, same as every
 *    other container) so `supabase stop`'s label-filtered sweep catches an orphaned shadow
 *    too — Go's `DockerStart` sets `CliProjectLabel`/`composeProjectLabel` unconditionally,
 *    regardless of the `container.Config` literal passed in. The project label alone is
 *    enough for that sweep to recognize an orphaned shadow: it filters and removes by
 *    container id, so the shadow's lack of a stable name doesn't matter.
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
