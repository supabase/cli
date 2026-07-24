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
 * creation (`commands/start/lib/container-lifecycle.ts`).
 */
export function legacyIsBitbucketPipeline(): boolean {
  const value = globalThis.process.env["BITBUCKET_CLONE_DIR"];
  return value !== undefined && value.length > 0;
}
