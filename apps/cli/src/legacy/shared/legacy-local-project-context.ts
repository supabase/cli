import {
  loadCliConfig,
  loadProjectEnvironment,
  CliConfigSchema,
  type LoadedCliConfig,
  type CliConfig,
} from "@supabase/config/effect";
import { Effect, FileSystem, Path, Schema } from "effect";

import { LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY } from "./legacy-bitbucket-pipeline.ts";
import { legacyResolveLocalProjectId, legacySanitizeProjectId } from "./legacy-docker-ids.ts";
import { legacyGetHostname } from "./legacy-hostname.ts";
import { legacyResolveProjectEnvironmentValues } from "./legacy-project-environment.ts";

/**
 * The config-load/env/project-id resolution `stop` (its non-`--all`/non-`--project-id` branch)
 * and `status` (unconditionally) both duplicated verbatim before this hoist.
 *
 * Deliberately excludes workdir validation (`legacyValidateWorkdirIsDirectory`,
 * `legacy-workdir-validation.ts`): both callers already invoke that themselves, at a point in
 * their own control flow that differs (`stop` validates unconditionally before its `--all`/
 * `--project-id` mutual-exclusivity check and bypass branching; `status` validates before its own
 * `--override-name` parsing, which itself must win over a config-load error). Folding workdir
 * validation into this function would force one of those two orderings to move, which would
 * silently change which error wins when multiple things are wrong at once — see `status.handler.ts`'s
 * own numbered comments for exactly why that ordering is load-bearing. Callers keep calling
 * {@link legacyValidateWorkdirIsDirectory} themselves, unchanged, before this.
 *
 * The sanitized project id (a singleton, rewritten once by validation
 * at config-load time) IS included here, even though `status`
 * previously computed it AFTER its own `legacyResolveStatusLocalState` call, and `stop` computed it
 * after its own `legacyResolveLocalConfigValues` call — both of those are pure, non-throwing string
 * derivations (`legacyResolveLocalProjectId`/`legacySanitizeProjectId`, see their own doc comments)
 * with no observable failure mode, so resolving it earlier here, ahead of each caller's own
 * subsequent (throwing) config-value resolution, cannot change which error a caller surfaces first.
 *
 * `mapConfigLoadError` lets each caller tag a config-load failure with its own command-specific
 * error type (`LegacyStopConfigLoadError`/`LegacyStatusConfigLoadError` today), matching the
 * `mapError: (message: string) => E` idiom already used by `legacy-migration-apply.ts`'s exports.
 */
export interface LegacyLocalProjectContext {
  readonly config: CliConfig;
  readonly projectEnvValues: Record<string, string>;
  /** `null` when no `supabase/config.toml` was found — see `loadCliConfig`'s own contract. */
  readonly loaded: LoadedCliConfig | null;
  readonly hostname: string;
  /** Config/env-derived, sanitized project id — see {@link legacySanitizeProjectId}'s doc comment. */
  readonly projectId: string;
}

export const legacyLoadLocalProjectContext = <E>(
  workdir: string,
  mapConfigLoadError: (message: string) => E,
  // The resolved `--linked`/`--project-ref` ref, when the caller already has one in scope
  // (`db diff`/`db pull`'s shadow-provisioning prelude — CLI-1956 — and the `functions`
  // Docker paths' Go-config pipeline — CLI-1963) — threaded straight into
  // `loadCliConfig`'s own `projectRef` option so the matching `[remotes.<ref>]` block
  // merges over the base config, exactly like `legacyReadDbToml(..., ref)` already does for
  // those same commands' OTHER config read. It also supplies `Eject` default:
  // `flags.LoadConfig` pre-sets `Config.ProjectId =
  // ProjectRef` before merging the file, so `Eject`'s own basename fallback only triggers
  // when that default is itself empty. `db start`/`db reset`/`start`/`stop`/`status` never
  // pass this, so it defaults to `undefined` — no remote merge, unchanged from before.
  projectRef?: string,
): Effect.Effect<LegacyLocalProjectContext, E, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // `search: false`: `workdir` already IS the fully-resolved chdir target (`legacy-cli-settings.
    // layer.ts`'s `resolveWorkdir` mirrors `ChangeWorkDir`'s explicit-exact-vs-default-searched
    // resolution), so letting `@supabase/config`'s
    // `findProjectPaths` climb ancestors again on top of that would let an unrelated ancestor
    // project's config.toml win when `--workdir`/`SUPABASE_WORKDIR` points at a subdirectory with
    // no `supabase/config.toml` of its own — this never searches past the exact (explicit or
    // defaulted) workdir (`NewPathBuilder`).
    const projectEnv = yield* loadProjectEnvironment({
      cwd: workdir,
      baseEnv: process.env,
      search: false,
      // `loadDefaultEnv` omits `.env.local`
      // from its candidate list whenever `SUPABASE_ENV=test` — a malformed or intentionally
      // non-test `supabase/.env.local` is then invisible to Go and must not fail config loading
      // here either. `legacyResolveProjectEnvironmentValues` below already applies this same gate
      // for the project-root pass; this mirrors it for the `supabase/`-dir pass
      // `loadProjectEnvironment` itself performs.
      skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );

    // Resolved BEFORE `loadCliConfig` decodes config.toml (not after): `Config.Load` runs
    // `loadNestedEnv` before `LoadEnvHook` decodes `env(...)` references, so
    // an `env(...)`-valued `project_id` sourced only from a project-root/`SUPABASE_ENV`-selected
    // file must already be visible to the decoder, not just to the `SUPABASE_PROJECT_ID` override
    // read below. A malformed extra dotenv file throws here (see `readDotEnvFile`), matching Go's
    // `loadNestedEnv` propagating `godotenv`'s parse error instead of silently skipping the bad
    // line. `workdir` is passed through so dotenv files under `<workdir>/supabase`/`workdir` are
    // still discovered even when `projectEnv` is `null` (no config.toml there) — Go's own
    // `loadNestedEnv` runs unconditionally, before `config.toml` is ever opened.
    const projectEnvValues = yield* Effect.try({
      try: () => legacyResolveProjectEnvironmentValues(projectEnv, workdir),
      catch: (cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`),
    });

    // `godotenv.Load` (`loadEnvIfExists`, called by `loadNestedEnv` above this same
    // config-load pass) installs every parsed dotenv key into
    // the process's OWN environment via `os.Setenv` — never overriding an already-set key —
    // so it's visible to every subsequent call in THIS process that reads `process.env` at
    // CALL time, not just to config decoding. `BITBUCKET_CLONE_DIR` is the
    // one key this applies to today: `os.Getenv("BITBUCKET_CLONE_DIR")` read
    // lives inside `DockerStart`, a regular
    // function invoked during the command's own `Run()`, well after config load has already
    // installed dotenv keys into the process env — not in a
    // package-level `var` initializer evaluated before that ever runs (see
    // {@link LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY}'s own doc comment; review:
    // PRRT_kwDOErm0O86VmHkm) — so a value set ONLY in a project `.env` file genuinely reaches
    // it too. Deliberately permanent (unlike `legacyApplyProjectEnv`'s own narrower,
    // explicitly-scoped opt-in around a single command's container work) — matching the
    // established non-reverting `os.Setenv`, which persists for that single-command process's entire
    // lifetime.
    for (const [key, value] of Object.entries(projectEnvValues)) {
      if (key === LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    // Deliberately NOT extended to Docker-client keys (`DOCKER_HOST`/`DOCKER_CONTEXT`/
    // `DOCKER_CONFIG`/etc, `legacyIsDockerClientEnvKey`), unlike an earlier version of this
    // function — same reasoning as `SUPABASE_SERVICES_HOSTNAME` right below, with even more
    // direct evidence: the reference implementation's ENTIRE Docker connectivity is the package-level
    // `var Docker = NewDocker()`, whose
    // `cli.Initialize(&dockerFlags.ClientOptions{})` reads these exact env vars once, at
    // BINARY STARTUP — before `main()` runs, before cobra parses argv, before any command's
    // `Run()` calls `flags.LoadConfig` -> `Config.Load` -> `loadNestedEnv` -> `godotenv.Load`.
    // The reference implementation never shells out to a `docker`/`podman` binary for its own
    // container work —
    // every container operation
    // goes through that single already-frozen SDK client, so a project-dotenv-only Docker-client
    // override can NEVER retarget that daemon, any more than it can retarget
    // `utils.Config.Hostname` below. Verified empirically (a scratch probe reproducing the exact
    // package-var-init-before-dotenv-load ordering): a value installed via `os.Setenv` after a
    // package var has already captured the environment never reaches that var. Installing these
    // keys here would make native `db start`/`start`/`stop`/`status` — which DO read
    // `process.env` at each `docker`/`podman` subprocess spawn (`legacy-hostname.ts`,
    // `extendEnv: true` at every spawn site) — inspect and mutate a DIFFERENT daemon than the Go
    // command targets: a NEW divergence from Go, not a fix for one (review:
    // PRRT_kwDOErm0O86WXFqw).

    // Deliberately NOT extended to `SUPABASE_SERVICES_HOSTNAME` (review: PRRT_kwDOErm0O86VlqIJ):
    // `GetHostname()` has exactly one call
    // site — `var Config = config.NewConfig(config.WithHostname(GetHostname()))`,
    // a package-level `var` initializer. Go's runtime evaluates
    // every package-level `var` before `main()` runs, which is before cobra parses argv, which is
    // before ANY command's `RunE`/`PersistentPreRunE` calls `flags.LoadConfig` -> `Config.Load` ->
    // `loadNestedEnv` -> `godotenv.Load`. So `utils.Config.Hostname` is permanently fixed to
    // whatever `os.Getenv("SUPABASE_SERVICES_HOSTNAME")` returns at Go BINARY STARTUP — before a
    // project dotenv file is ever parsed by that process — and nothing re-reads `GetHostname()`
    // afterward to pick up a dotenv-installed value. Verified empirically (scratch probe
    // reproducing the exact package-var-init-before-dotenv-load ordering): a project-dotenv-only
    // `SUPABASE_SERVICES_HOSTNAME` never reaches Go's hostname resolution; only a value already
    // present in the shell env before the binary starts does. `legacyGetHostname()` right below
    // must therefore NOT see a project-dotenv-only override either — installing it into
    // `process.env` here would make native `db start`/`start`/`stop`/`status` honor a case Go's
    // own `utils.Config.Hostname` can never observe, which is a NEW divergence from Go, not a fix
    // for one.

    // An absent config.toml is not a failure — `flags.LoadConfig` still resolves a project id
    // via the workdir basename default. Only a malformed file (`loadCliConfig` failing rather
    // than returning `null`) is a hard error.
    const loaded = yield* loadCliConfig(workdir, {
      projectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
      search: false,
      // `NewPathBuilder`/`Config.Load` only ever resolves
      // `supabase/config.toml` — it has no concept of a JSON project config file. Without this, a
      // workdir with a stray `config.json` would make `loadCliConfig` prefer it over
      // `config.toml`.
      tomlOnly: true,
      goViperCompat: true,
      projectRef,
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(CliConfigSchema)({});
    const hostname = legacyGetHostname();
    // `loaded?.appliedRemote !== undefined` means a `[remotes.<ref>]` block matched
    // `projectRef` above and `loadCliConfig` merged it over the base document
    // (`packages/config/src/io.ts`'s `applyRemoteOverride`) — including that block's OWN
    // `project_id` field, which is what selected it (`config.project_id` already equals
    // `projectRef`). `mergeRemoteConfig` installs that value at viper's override tier,
    // above `AutomaticEnv`, so a stale/
    // differently-scoped `SUPABASE_PROJECT_ID` must not win over it here either — otherwise
    // this context's `projectId` (network id, container labels — same field
    // `legacy-db-config.toml-read.ts`'s own `project_id` gating protects for the pg-delta
    // context) resolves the WRONG id for a linked `db diff --linked`/`db pull` shadow
    // (review: PRRT_kwDOErm0O86XHGDL).
    const projectId = legacySanitizeProjectId(
      legacyResolveLocalProjectId(
        loaded?.appliedRemote !== undefined
          ? undefined
          : (projectEnvValues["SUPABASE_PROJECT_ID"] ?? process.env["SUPABASE_PROJECT_ID"]),
        config.project_id,
        workdir,
        projectRef,
      ),
    );

    return { config, projectEnvValues, loaded, hostname, projectId };
  });
