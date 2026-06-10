import { Effect, type FileSystem, Option, type Path } from "effect";
import * as SmolToml from "smol-toml";
import { LegacyDbConfigLoadError } from "./legacy-db-config.errors.ts";

/**
 * Subset of `supabase/config.toml` (plus the linked pooler URL) the db-config
 * resolver needs.
 *
 * Mirrors Go's `flags.LoadConfig` → `config.Load`
 * (`apps/cli-go/internal/utils/flags/config_path.go:10`,
 * `pkg/config/config.go`): a **missing** config file yields `config.NewConfig()`
 * defaults, but a **malformed** file is a hard error (Go returns the decode error
 * and aborts the command rather than running against the default local database).
 */
interface LegacyDbTomlValues {
  /** `[db] port`, default 54322 (`packages/config/src/db.ts`). */
  readonly port: number;
  /** `[db] shadow_port`, default 54320. */
  readonly shadowPort: number;
  /** `[db] password`, runtime default `"postgres"` (not in the config schema). */
  readonly password: string;
  /**
   * Linked connection pooler URL, used by the `--linked` pooler fallback. Written
   * by `supabase link` to `supabase/.temp/pooler-url` — Go reads it from there, not
   * from config.toml (the config field is tagged `toml:"-"`, `pkg/config/db.go:116`;
   * it is populated programmatically in `config.Load`, `config.go:626`).
   */
  readonly poolerConnectionString: Option.Option<string>;
  /** top-level `project_id`, used to name the local docker network. */
  readonly projectId: Option.Option<string>;
}

const DEFAULT_PORT = 54322;
const DEFAULT_SHADOW_PORT = 54320;
const DEFAULT_PASSWORD = "postgres";

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

const ENV_PATTERN = /^env\((.*)\)$/;

/**
 * Expand Go's `env(VAR)` config form. Mirrors `LoadEnvHook`
 * (`apps/cli-go/pkg/config/decode_hooks.go`): a string matching `^env\((.*)\)$`
 * resolves to the named environment variable, but only when that variable is set
 * and non-empty; otherwise the literal value is preserved unchanged (Go's hook
 * keeps `value` when `len(os.Getenv(name)) == 0`).
 */
function expandEnv(value: string): string {
  const matches = ENV_PATTERN.exec(value);
  if (matches !== null) {
    const env = process.env[matches[1] ?? ""];
    if (env !== undefined && env.length > 0) return env;
  }
  return value;
}

/** `[db]` ports decode into Go's `uint16` (`pkg/config/db.go:84-85`). */
const MAX_PORT = 65535;

/**
 * Resolve a `[db]` port field. Go decodes the TOML value into a `uint16`
 * (`config.Load` via `mapstructure`'s weakly-typed input, *after* `LoadEnvHook`
 * runs), so an `env(VAR)` reference written as a quoted string is expanded and
 * then parsed as the port. Parity rules:
 *
 * - **Omitted** (`undefined`) → the schema default.
 * - **Present and resolves to a `uint16`** (a plain integer in range, or an
 *   `env(VAR)` string that expands to one) → that value.
 * - **Present but cannot unmarshal** (non-numeric, negative, out of range, or an
 *   unresolved `env(VAR)`) → `undefined`, signalling the caller to abort with
 *   `LegacyDbConfigLoadError`. Go errors here rather than silently defaulting and
 *   running against the default local database while hiding a broken config.
 */
function resolvePort(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= MAX_PORT ? value : undefined;
  }
  if (typeof value === "string") {
    const expanded = expandEnv(value);
    if (/^\d+$/.test(expanded)) {
      const parsed = Number(expanded);
      if (parsed <= MAX_PORT) return parsed;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
}

/**
 * Reads `<workdir>/supabase/config.toml` (db subtree + project id) and the linked
 * `<workdir>/supabase/.temp/pooler-url`. `fs`/`path` are passed in so the resolver
 * can capture them once and keep its own `R` at `never`.
 *
 * Fails with `LegacyDbConfigLoadError` only when the config file is present but
 * unparseable; an absent file (and an absent/empty pooler-url file) is not an error.
 */
export const legacyReadDbToml = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const configPath = path.join(supabaseDir, "config.toml");

  // Distinguish "absent" (→ defaults) from "present but unreadable/malformed" (→ fail),
  // matching Go's `mergeFileConfig` (`pkg/config/config.go:528`): only `os.ErrNotExist`
  // is swallowed, every other read error aborts rather than silently running against the
  // default local database. Effect surfaces "not found" as `PlatformError` with a
  // `SystemError` reason tagged `"NotFound"`.
  const maybeContent = yield* fs.readFileString(configPath).pipe(
    Effect.map(Option.some<string>),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
            new LegacyDbConfigLoadError({
              message: `failed to read file config: ${error.message}`,
            }),
          ),
    ),
  );

  let db: RawDoc | undefined;
  let projectId = Option.none<string>();
  if (Option.isSome(maybeContent)) {
    let doc: RawDoc | undefined;
    try {
      doc = asRecord(SmolToml.parse(maybeContent.value));
    } catch (cause) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
    db = asRecord(doc?.["db"]);
    projectId = nonEmptyString(doc?.["project_id"]);
  }

  // Go: `config.go:626` — read the linked pooler URL from `.temp/pooler-url` and
  // treat it as configured only when the file exists and is non-empty.
  const poolerUrlPath = path.join(supabaseDir, ".temp", "pooler-url");
  const poolerConnectionString = yield* fs
    .readFileString(poolerUrlPath)
    .pipe(Effect.map(nonEmptyString), Effect.orElseSucceed(Option.none<string>));

  // A present-but-unmarshalable port aborts in Go rather than defaulting; mirror
  // that so `test db --local` never silently targets the default local database
  // while hiding a broken `[db]` config.
  const port = resolvePort(db?.["port"], DEFAULT_PORT);
  const shadowPort = resolvePort(db?.["shadow_port"], DEFAULT_SHADOW_PORT);
  if (port === undefined || shadowPort === undefined) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: `failed to load config: invalid ${port === undefined ? "db.port" : "db.shadow_port"} value`,
      }),
    );
  }

  const values: LegacyDbTomlValues = {
    port,
    shadowPort,
    password: typeof db?.["password"] === "string" ? expandEnv(db["password"]) : DEFAULT_PASSWORD,
    poolerConnectionString,
    projectId,
  };
  return values;
});
