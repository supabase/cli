import {
  loadProjectConfig,
  loadProjectEnvironment,
  ProjectConfigSchema,
  type LoadedProjectConfig,
  type ProjectConfig,
} from "@supabase/config";
import { Effect, FileSystem, Path, Schema } from "effect";

import { legacyIsDockerClientEnvKey } from "./db-bootstrap/docker-create-args.ts";
import { legacyResolveLocalProjectId, legacySanitizeProjectId } from "./legacy-docker-ids.ts";
import { legacyGetHostname } from "./legacy-hostname.ts";
import { legacyResolveProjectEnvironmentValues } from "./legacy-project-environment.ts";

/**
 * The config-load/env/project-id resolution `stop` (its non-`--all`/non-`--project-id` branch)
 * and `status` (unconditionally) both duplicated verbatim before this hoist. Ported from Go's
 * `flags.LoadConfig` (config load, `internal/utils/flags/config_path.go:10-14` ->
 * `pkg/config/config.go:882`) plus `utils.GetHostname`/`GetId`'s project-id resolution
 * (`internal/utils/misc.go:231-311`, `internal/utils/config.go`).
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
 * The sanitized project id (Go's `Config.ProjectId` singleton, rewritten once by `Config.Validate`
 * at config-load time, `pkg/config/config.go:938-944`) IS included here, even though `status`
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
  readonly config: ProjectConfig;
  readonly projectEnvValues: Record<string, string>;
  /** `null` when no `supabase/config.toml` was found — see `loadProjectConfig`'s own contract. */
  readonly loaded: LoadedProjectConfig | null;
  readonly hostname: string;
  /** Config/env-derived, sanitized project id — see {@link legacySanitizeProjectId}'s doc comment. */
  readonly projectId: string;
}

export const legacyLoadLocalProjectContext = <E>(
  workdir: string,
  mapConfigLoadError: (message: string) => E,
): Effect.Effect<LegacyLocalProjectContext, E, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // `search: false`: `workdir` already IS Go's fully-resolved chdir target (`legacy-cli-config.
    // layer.ts`'s `resolveWorkdir` mirrors `ChangeWorkDir`'s explicit-exact-vs-default-searched
    // resolution, `apps/cli-go/internal/utils/misc.go:231-247`), so letting `@supabase/config`'s
    // `findProjectPaths` climb ancestors again on top of that would let an unrelated ancestor
    // project's config.toml win when `--workdir`/`SUPABASE_WORKDIR` points at a subdirectory with
    // no `supabase/config.toml` of its own — Go never searches past the exact (explicit or
    // defaulted) workdir (`NewPathBuilder`, `pkg/config/utils.go:43-48`).
    const projectEnv = yield* loadProjectEnvironment({
      cwd: workdir,
      baseEnv: process.env,
      search: false,
      // Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/config.go:1243-1250`) omits `.env.local`
      // from its candidate list whenever `SUPABASE_ENV=test` — a malformed or intentionally
      // non-test `supabase/.env.local` is then invisible to Go and must not fail config loading
      // here either. `legacyResolveProjectEnvironmentValues` below already applies this same gate
      // for the project-root pass; this mirrors it for the `supabase/`-dir pass
      // `loadProjectEnvironment` itself performs.
      skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );

    // Resolved BEFORE `loadProjectConfig` decodes config.toml (not after): Go's `Config.Load` runs
    // `loadNestedEnv` before `LoadEnvHook` decodes `env(...)` references (`config.go:735-738`), so
    // an `env(...)`-valued `project_id` sourced only from a project-root/`SUPABASE_ENV`-selected
    // file must already be visible to the decoder, not just to the `SUPABASE_PROJECT_ID` override
    // read below. A malformed extra dotenv file throws here (see `readDotEnvFile`), matching Go's
    // `loadNestedEnv` propagating `godotenv`'s parse error instead of silently skipping the bad
    // line. `workdir` is passed through so dotenv files under `<workdir>/supabase`/`workdir` are
    // still discovered even when `projectEnv` is `null` (no config.toml there) — Go's own
    // `loadNestedEnv` runs unconditionally, before `config.toml` is ever opened
    // (`pkg/config/config.go:786-793`).
    const projectEnvValues = yield* Effect.try({
      try: () => legacyResolveProjectEnvironmentValues(projectEnv, workdir),
      catch: (cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`),
    });

    // Go's `godotenv.Load` (`loadEnvIfExists`, called by `loadNestedEnv` above this same
    // `Config.Load` pass, `pkg/config/config.go:1261`) installs every parsed dotenv key into
    // the process's OWN environment via `os.Setenv` — never overriding an already-set key —
    // so it's visible to every subsequent Docker-client-facing call in THIS process, not just
    // to `Config.Load`'s own field decoding. `legacyGetHostname()` right below, and every
    // Docker subprocess this context's callers (`start`/`stop`/`status`/`db start`) spawn
    // afterward, read `DOCKER_HOST`/`DOCKER_CONTEXT`/etc straight from `process.env`
    // (`legacy-hostname.ts`, `extendEnv: true` at every `docker`/`podman` spawn site) — a
    // daemon target configured ONLY in a project `.env` file (never exported to the shell)
    // must land here, before `legacyGetHostname()` runs, or this whole context resolves
    // against the WRONG daemon. Deliberately permanent (unlike `legacyApplyProjectEnv`'s own
    // narrower, explicitly-scoped opt-in around a single command's container work) — matching
    // Go's own non-reverting `os.Setenv`, which persists for that single-command process's
    // entire lifetime.
    for (const [key, value] of Object.entries(projectEnvValues)) {
      if (legacyIsDockerClientEnvKey(key) && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    // Deliberately NOT extended to `SUPABASE_SERVICES_HOSTNAME` (review: PRRT_kwDOErm0O86VlqIJ):
    // Go's `GetHostname()` (`apps/cli-go/internal/utils/misc.go:305-311`) has exactly one call
    // site — `var Config = config.NewConfig(config.WithHostname(GetHostname()))`
    // (`internal/utils/config.go:100`), a package-level `var` initializer. Go's runtime evaluates
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

    // An absent config.toml is not a failure — Go's `flags.LoadConfig` still resolves a project id
    // via the workdir basename default. Only a malformed file (`loadProjectConfig` failing rather
    // than returning `null`) is a hard error.
    const loaded = yield* loadProjectConfig(workdir, {
      projectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
      search: false,
      // Go's `NewPathBuilder`/`Config.Load` (`pkg/config/utils.go:43-48`) only ever resolves
      // `supabase/config.toml` — it has no concept of a JSON project config file. Without this, a
      // workdir with a stray `config.json` would make `loadProjectConfig` prefer it over
      // `config.toml`.
      tomlOnly: true,
      goViperCompat: true,
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(ProjectConfigSchema)({});
    const hostname = legacyGetHostname();
    const projectId = legacySanitizeProjectId(
      legacyResolveLocalProjectId(
        projectEnvValues["SUPABASE_PROJECT_ID"] ?? process.env["SUPABASE_PROJECT_ID"],
        config.project_id,
        workdir,
      ),
    );

    return { config, projectEnvValues, loaded, hostname, projectId };
  });
