import {
  loadCliProjectEnvironment,
  CliConfigSchema,
  type LoadedCliConfig,
  type CliConfig,
} from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { Effect, FileSystem, Path, Schema } from "effect";

import { BITBUCKET_CLONE_DIR_ENV_KEY } from "./bitbucket-pipeline.ts";
import { resolveLocalProjectId, sanitizeProjectId } from "./docker-ids.ts";
import { getHostname } from "./hostname.ts";
import { resolveProjectEnvironmentValues } from "./project-environment.ts";

/** Config, resolved project env values, hostname, and sanitized project id for a command. */
export interface LocalProjectContext {
  readonly config: CliConfig;
  readonly projectEnvValues: Record<string, string>;
  /** `null` when no `supabase/config.toml` was found. */
  readonly loaded: LoadedCliConfig | null;
  readonly hostname: string;
  /** Sanitized project id; see {@link sanitizeProjectId}. */
  readonly projectId: string;
}

export const loadLocalProjectContext = <E>(
  workdir: string,
  mapConfigLoadError: (message: string) => E,
  // An already-resolved `--linked`/`--project-ref` value, when the caller has one; merges the
  // matching `[remotes.<ref>]` block over the base config. Defaults to `undefined` (no remote
  // merge) for callers that don't have one yet.
  projectRef?: string,
): Effect.Effect<LocalProjectContext, E, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // `workdir` is already the fully-resolved chdir target, so `search: false` stops
    // `@supabase/config` from climbing ancestors and picking up an unrelated project's
    // config.toml when `workdir` has none of its own.
    const projectEnv = yield* loadCliProjectEnvironment({
      cwd: workdir,
      baseEnv: process.env,
      search: false,
      // Omits `.env.local` when `SUPABASE_ENV=test`, matching
      // `resolveProjectEnvironmentValues`'s gating for the project-root pass.
      skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );

    // Must resolve before `loadCliConfig` decodes config.toml: an `env(...)`-valued `project_id`
    // needs these values available to the decoder already. `workdir` is passed through so dotenv
    // files under `<workdir>/supabase` are still discovered even when `projectEnv` is `null`.
    const projectEnvValues = yield* Effect.try({
      try: () => resolveProjectEnvironmentValues(projectEnv, workdir),
      catch: (cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`),
    });

    // Installs `BITBUCKET_CLONE_DIR_ENV_KEY` into `process.env` for the rest of this process's
    // lifetime, without overriding an already-set value, so a value set only in a project `.env`
    // file is visible to the later code that reads it directly from `process.env`.
    for (const [key, value] of Object.entries(projectEnvValues)) {
      if (key === BITBUCKET_CLONE_DIR_ENV_KEY && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    // Docker-client env vars (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, etc.) and
    // `SUPABASE_SERVICES_HOSTNAME` are resolved once, earlier in process startup, so installing
    // them here from a project dotenv file would have no effect and must not be added to the
    // loop above.

    // An absent config.toml is not a failure — a project id still resolves from the workdir
    // basename default. Only a malformed file is a hard error.
    const loaded = yield* loadCliConfig(workdir, {
      cliProjectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
      search: false,
      // Restricts resolution to `supabase/config.toml`; without this, a workdir with a stray
      // `config.json` would be preferred over it.
      tomlOnly: true,
      goViperCompat: true,
      projectRef,
    }).pipe(
      Effect.mapError((cause) => mapConfigLoadError(`failed to read config: ${String(cause)}`)),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(CliConfigSchema)({});
    const hostname = getHostname();
    // When a `[remotes.<ref>]` block matched `projectRef` above, its own `project_id` field is
    // what selected it, so a stale or differently-scoped `SUPABASE_PROJECT_ID` must not win over
    // it here.
    const projectId = sanitizeProjectId(
      resolveLocalProjectId(
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
