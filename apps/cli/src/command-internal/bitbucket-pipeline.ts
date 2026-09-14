/**
 * Exported so `local-project-context.ts` can install this key from a project dotenv file
 * into `process.env` before {@link isBitbucketPipeline} ever runs.
 */
export const BITBUCKET_CLONE_DIR_ENV_KEY = "BITBUCKET_CLONE_DIR";

/**
 * Whether the process is running inside a Bitbucket Pipelines runner, whose
 * Docker-in-Docker environment disallows named volumes and `--security-opt`. Hoisted here
 * for reuse across every container-runtime call site that creates volumes or sets security
 * options.
 * @see https://support.atlassian.com/bitbucket-cloud/docs/run-docker-commands-in-bitbucket-pipelines/#Full-list-of-restricted-commands
 */
export function isBitbucketPipeline(): boolean {
  const value = globalThis.process.env[BITBUCKET_CLONE_DIR_ENV_KEY];
  return value !== undefined && value.length > 0;
}
