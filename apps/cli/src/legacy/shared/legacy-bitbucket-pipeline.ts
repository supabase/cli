/**
 * `BITBUCKET_CLONE_DIR` — exported so `legacy-local-project-context.ts` can install it from a
 * project dotenv file into `process.env` before this check ever runs. Unlike
 * `SUPABASE_SERVICES_HOSTNAME` (deliberately NOT installed, see that file's own doc comment),
 * Go's `os.Getenv("BITBUCKET_CLONE_DIR")` read (`apps/cli-go/internal/utils/docker.go:401`) lives
 * inside `DockerStart`, a regular function invoked during the command's own `Run()`, well after
 * `flags.LoadConfig` -> `godotenv.Load` has already installed dotenv keys into the process env
 * (`pkg/config/config.go:786-791,1261`) — not in a package-level `var` initializer evaluated
 * before `godotenv.Load` ever runs (review: PRRT_kwDOErm0O86VmHkm).
 */
export const LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY = "BITBUCKET_CLONE_DIR";

/**
 * Whether the current process is running inside a Bitbucket Pipelines runner,
 * mirroring Go's `os.Getenv("BITBUCKET_CLONE_DIR") != ""` check
 * (`apps/cli-go/internal/utils/docker.go:401`). Bitbucket's Docker-in-Docker
 * runner disallows named volumes and `--security-opt`
 * (https://support.atlassian.com/bitbucket-cloud/docs/run-docker-commands-in-bitbucket-pipelines/#Full-list-of-restricted-commands),
 * so every container-runtime call site that creates volumes or sets security
 * options needs this same check.
 *
 * Hoisted here because it is needed by ≥2 call sites: `legacy-docker-run.layer.ts`
 * (`docker run`, e.g. `db dump`/`db test`) and `start`'s per-service container
 * creation (`legacy/shared/db-bootstrap/container-lifecycle.ts`).
 */
export function legacyIsBitbucketPipeline(environment: Readonly<Record<string, string>>): boolean {
  const value = environment[LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY];
  return value !== undefined && value.length > 0;
}
