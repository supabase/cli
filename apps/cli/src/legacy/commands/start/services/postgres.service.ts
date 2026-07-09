/**
 * Port of Go's `NewContainerConfig`/`NewHostConfig`
 * (`apps/cli-go/internal/db/start/start.go:63-131`): builds the
 * {@link LegacyStartContainerSpec} for `supabase start`'s Postgres container.
 *
 * Deliberately out of scope, per the approved start-port plan:
 *  - `StartDatabase`'s `fromBackup` restore branch (`start.go:143-164`,
 *    `templates/restore.sh`) — `supabase start` always calls `StartDatabase`
 *    with an empty `fromBackup` (`apps/cli-go/internal/start/start.go:295`),
 *    so that whole branch is dead code on this path.
 *  - `SetupLocalDatabase` (initial schema bootstrap, `start.go:184-187`) — an
 *    explicit follow-up, not container construction.
 *  - Actually creating/starting the container and waiting for it to become
 *    healthy — that's {@link legacyStartContainer} (`../lib/container-lifecycle.ts`)
 *    and {@link legacyWaitForHealthyServices} (`../lib/health-check.ts`), wired
 *    up by a later `start.handler.ts` task.
 */

import type { ProjectConfig } from "@supabase/config";

import { localDbContainerId } from "../../../shared/legacy-docker-ids.ts";
import { encodeToml } from "../../../shared/legacy-go-output.encoders.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";
import { LEGACY_START_DB_SCHEMA_SQL } from "../templates/db-schema.sql.ts";
import { LEGACY_START_DB_SUPABASE_SQL } from "../templates/db-supabase.sql.ts";
import { LEGACY_START_DB_WEBHOOK_SQL } from "../templates/db-webhook.sql.ts";

/** Go's `Db.Password` default (`pkg/config/config.go:459`). `db.password` has no
 * config.toml field (`toml:"-"`, `pkg/config/db.go:88`), so this is the only value
 * this port can ever observe — matches `DEFAULT_DB_PASSWORD` in
 * `legacy-local-config-values.ts`, not imported from there since that constant
 * isn't exported and status/stop's resolver is otherwise unrelated to this module. */
const LEGACY_POSTGRES_PASSWORD = "postgres";

/**
 * Go's `Db.RootKey` default (`apps/cli-go/pkg/config/config.go:460-462`).
 * `db.root_key` isn't modeled in `@supabase/config`'s schema yet (every other
 * `db.*` TOML field is) — `legacy-db-config.toml-read.ts` only validates that a
 * configured `root_key` decrypts, it doesn't expose a resolved value the way
 * `legacyResolveLocalConfigValues` does for `jwtSecret`. Until that exists,
 * there is no code path that can feed a configured override into this builder,
 * so this constant is the value every caller observes today.
 * {@link LegacyPostgresStartServiceInput.rootKey} stays an optional override
 * (rather than this module hardcoding it unconditionally) so a future caller
 * that resolves `db.root_key` (default-or-decrypted, the same shape
 * `jwtSecret` already gets) can pass the resolved value straight through
 * without this module changing.
 */
export const LEGACY_POSTGRES_DEFAULT_ROOT_KEY =
  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275";

/**
 * The exact in-container path Go's PG >= 15 entrypoint heredocs the pgsodium
 * root key to (`start.go:96`) — now a `secretFiles` bind-mount target instead
 * (see {@link legacyBuildPostgresStartContainerSpec}), not a heredoc.
 */
const LEGACY_POSTGRES_PGSODIUM_ROOT_KEY_PATH = "/etc/postgresql-custom/pgsodium_root.key";

/** Go's `container.HealthConfig` literals (`apps/cli-go/internal/db/start/start.go:85-90`). */
const LEGACY_POSTGRES_HEALTHCHECK_INTERVAL_SECONDS = 10;
const LEGACY_POSTGRES_HEALTHCHECK_TIMEOUT_SECONDS = 2;
const LEGACY_POSTGRES_HEALTHCHECK_RETRIES = 3;

/** Go's `utils.DbAliases` (`apps/cli-go/internal/utils/config.go:36`). */
const LEGACY_POSTGRES_NETWORK_ALIASES: ReadonlyArray<string> = ["db", "db.supabase.internal"];

/** Go's version-compare threshold (`apps/cli-go/internal/db/start/start.go:79`). */
const LEGACY_POSTGRES_INITDB_VERSION_THRESHOLD = "15.8.1.005";

const LEGACY_POSTGRES_CONFIG_HEADER = "\n# supabase [db.settings] configuration\n";

export interface LegacyPostgresStartServiceInput {
  /** Decoded `[db]` section — every field this builder needs (`port`, `major_version`, `settings`) lives here. */
  readonly db: ProjectConfig["db"];
  /** Decoded `[experimental]` section — only the OrioleDB/S3 fields are read. */
  readonly experimental: ProjectConfig["experimental"];
  /** Already-resolved (default-or-configured, decrypted) `auth.jwt_secret` — same shape `legacyResolveLocalConfigValues` produces. */
  readonly jwtSecret: string;
  /** `config.auth.jwt_expiry`. */
  readonly jwtExpiry: number;
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s doc comment. */
  readonly projectId: string;
  /** `utils.NetId` — the local stack's docker network id. */
  readonly networkId: string;
  /** `utils.Config.Db.Image`, already resolved/pulled (see `../lib/image-prepull.ts`). */
  readonly image: string;
  /** Already-resolved `db.root_key` value. Defaults to {@link LEGACY_POSTGRES_DEFAULT_ROOT_KEY} when omitted — see that constant's doc comment for why. */
  readonly rootKey?: string;
}

/**
 * Port of Go's `(a *settings) ToPostgresConfig()`
 * (`apps/cli-go/pkg/config/db.go:181-190`): serializes `db.settings` as TOML —
 * only the fields actually set, matching Go's nil-pointer fields never being
 * written — replaces every `"` with `'`, and prepends the fixed header
 * comment.
 *
 * Reuses the shared {@link encodeToml} (`legacy-go-output.encoders.ts`, backed
 * by `smol-toml`) for the actual line rendering: `smol-toml`'s `stringifyTable`
 * already skips `undefined`/`null` values exactly like Go's TOML encoder
 * (`github.com/BurntSushi/toml`'s `eStruct`) skips nil pointers — verified
 * against that library's source, which omits a nil field unconditionally, with
 * no `omitempty` tag required — and its integer/string/boolean formatting
 * already matches Go's (unquoted numbers/bools, double-quoted strings, single-
 * quoted here afterward). The one divergence: `smol-toml`'s `stringify` always
 * appends a trailing `\n`, even for an empty object (`stringify({})` →
 * `"\n"`), whereas Go's `ToTomlBytes` of an all-nil-pointer struct returns the
 * empty string (`TestSettingsToPostgresConfig`'s "Empty settings should
 * result in empty string" case) — so the empty-settings case is special-cased
 * below instead of delegated to `encodeToml`.
 *
 * `settings` itself is typed optional (`ProjectConfig["db"]["settings"]`
 * includes `undefined`) because `db.ts` wraps the whole `[db.settings]` table
 * in `Schema.optionalKey` — in practice the schema's own `withDecodingDefaultKey`
 * always fills in `{}` when the section is absent, but this stays defensive
 * against the static type either way, matching Go's `settings` being a plain
 * (never-nil) struct value.
 */
export function legacyPostgresSettingsToPostgresConfig(
  settings: ProjectConfig["db"]["settings"],
): string {
  const defined = Object.fromEntries(
    Object.entries(settings ?? {}).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(defined).length === 0) {
    return LEGACY_POSTGRES_CONFIG_HEADER;
  }
  const toml = encodeToml(defined).replaceAll('"', "'");
  return `${LEGACY_POSTGRES_CONFIG_HEADER}${toml}`;
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
export function legacyPostgresVersionCompare(a: string, b: string): number {
  const [aHead, aTail] = legacySplitVersionHeadTail(a);
  const [bHead, bTail] = legacySplitVersionHeadTail(b);
  const headCompare = legacyCompareVersionStrings(aHead, bHead);
  if (headCompare !== 0) return headCompare;
  return legacyCompareVersionStrings(aTail, bTail);
}

function legacySplitVersionHeadTail(version: string): readonly [string, string] {
  const parts = version.split(".");
  if (parts.length <= 3) return [version, ""];
  return [parts.slice(0, 3).join("."), parts.slice(3).join(".").replace(/^0+/, "")];
}

function legacyIsValidDottedVersion(version: string): boolean {
  return version.length > 0 && version.split(".").every((part) => /^\d+$/.test(part));
}

function legacyCompareVersionStrings(a: string, b: string): number {
  const aValid = legacyIsValidDottedVersion(a);
  const bValid = legacyIsValidDottedVersion(b);
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
 * this point in Go's pipeline, so the first colon is always the name/tag
 * separator; this port's `image` argument may already carry a registry host
 * prefix from multi-registry resolution (`legacyGetRegistryImageUrlCandidates`,
 * `../../../shared/legacy-docker-registry.ts`), but none of those candidate
 * hosts (`public.ecr.aws`, `ghcr.io`, `docker.io`) contain a colon themselves,
 * so the first colon in the resolved string is still the same name/tag
 * separator Go's unprefixed string would have had. When no colon is present at
 * all, Go's slice expression degrades to the whole string (`Image[0:]`) —
 * reproduced here the same way.
 */
export function legacyPostgresImageVersionTag(image: string): string {
  const colonIndex = image.indexOf(":");
  return colonIndex === -1 ? image : image.slice(colonIndex + 1);
}

/**
 * Go's OrioleDB / version-compare `Env` branch (`start.go:70-81`) — an
 * `else if`, so at most one of the two ever fires.
 */
function legacyPostgresExtraEnv(
  experimental: ProjectConfig["experimental"],
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
  const tag = legacyPostgresImageVersionTag(image);
  if (legacyPostgresVersionCompare(tag, LEGACY_POSTGRES_INITDB_VERSION_THRESHOLD) < 0) {
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
 * {@link LegacyStartContainerSpec.secretFiles} instead (a HOST temp file,
 * mode `0600`, bind-mounted read-only at that exact path — see
 * {@link legacyBuildPostgresStartContainerSpec}), so it never appears in this
 * process's own `docker create` argv (CWE-214/522).
 *
 * Otherwise byte-for-byte derived from Go's raw-string concatenation
 * (including the trailing space after `/etc/postgresql` — Go's
 * `NewContainerConfig(args ...string)` joins its variadic `args` there,
 * always empty for `supabase start`, so the space survives as-is); built via
 * explicit `"...\n" +` concatenation rather than a multi-line template
 * literal so that trailing space stays a visible, lint/format-proof string
 * character instead of invisible end-of-line whitespace.
 */
function legacyPostgresEntrypointScriptPg15(postgresConfig: string): string {
  return (
    "\n" +
    "cat <<'EOF' > /etc/postgresql.schema.sql && \\\n" +
    "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
    "docker-entrypoint.sh postgres -D /etc/postgresql \n" +
    `${LEGACY_START_DB_SCHEMA_SQL}\n` +
    `${LEGACY_START_DB_WEBHOOK_SQL}\n` +
    `${LEGACY_START_DB_SUPABASE_SQL}\n` +
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
 * `docker-entrypoint.sh`. See {@link legacyPostgresEntrypointScriptPg15}'s doc
 * comment for why this is explicit concatenation rather than a template
 * literal.
 */
function legacyPostgresEntrypointScriptPg14(postgresConfig: string): string {
  return (
    "\n" +
    "cat <<'EOF' > /docker-entrypoint-initdb.d/supabase_schema.sql && \\\n" +
    "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
    "docker-entrypoint.sh postgres -D /etc/postgresql \n" +
    `${LEGACY_START_DB_SUPABASE_SQL}\n` +
    "EOF\n" +
    `${postgresConfig}\n` +
    "EOF"
  );
}

/**
 * Builds the {@link LegacyStartContainerSpec} for `supabase start`'s Postgres
 * container — see this module's header for what's deliberately out of scope.
 */
export function legacyBuildPostgresStartContainerSpec(
  input: LegacyPostgresStartServiceInput,
): LegacyStartContainerSpec {
  const containerName = localDbContainerId(input.projectId);
  const rootKeyValue = input.rootKey ?? LEGACY_POSTGRES_DEFAULT_ROOT_KEY;
  const postgresConfig = legacyPostgresSettingsToPostgresConfig(input.db.settings);
  const isPg14OrEarlier = input.db.major_version <= 14;

  const env: Record<string, string> = {
    POSTGRES_PASSWORD: LEGACY_POSTGRES_PASSWORD,
    POSTGRES_HOST: "/var/run/postgresql",
    JWT_SECRET: input.jwtSecret,
    JWT_EXP: String(input.jwtExpiry),
    ...legacyPostgresExtraEnv(input.experimental, input.image),
  };

  const script = isPg14OrEarlier
    ? legacyPostgresEntrypointScriptPg14(postgresConfig)
    : legacyPostgresEntrypointScriptPg15(postgresConfig);

  return {
    image: input.image,
    containerName,
    env,
    entrypoint: "sh",
    cmd: ["-c", script],
    binds: [`${containerName}:/var/lib/postgresql/data`],
    ...(isPg14OrEarlier ? { tmpfs: { "/docker-entrypoint-initdb.d": "" } } : {}),
    ...(isPg14OrEarlier
      ? {}
      : {
          secretFiles: [
            { containerPath: LEGACY_POSTGRES_PGSODIUM_ROOT_KEY_PATH, content: rootKeyValue },
          ],
        }),
    ports: [{ hostPort: String(input.db.port), containerPort: "5432" }],
    healthcheck: {
      test: ["CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"],
      intervalSeconds: LEGACY_POSTGRES_HEALTHCHECK_INTERVAL_SECONDS,
      timeoutSeconds: LEGACY_POSTGRES_HEALTHCHECK_TIMEOUT_SECONDS,
      retries: LEGACY_POSTGRES_HEALTHCHECK_RETRIES,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: LEGACY_POSTGRES_NETWORK_ALIASES,
    labels: {},
  };
}
