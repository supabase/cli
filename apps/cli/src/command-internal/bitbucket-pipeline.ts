import { Config, Effect, Option } from "effect";

const BITBUCKET_CLONE_DIR_ENV_KEY = "BITBUCKET_CLONE_DIR";

/**
 * Resolves the Bitbucket marker, preferring the supplied project value. Callers should provide a
 * project map with ambient values already layered over dotenv values.
 * @see https://support.atlassian.com/bitbucket-cloud/docs/run-docker-commands-in-bitbucket-pipelines/#Full-list-of-restricted-commands
 */
export const bitbucketCloneDir = Effect.fnUntraced(function* (
  projectEnvValues?: Readonly<Record<string, string>>,
) {
  if (projectEnvValues !== undefined) {
    const projectValue = Option.fromNullishOr(projectEnvValues[BITBUCKET_CLONE_DIR_ENV_KEY]);
    if (Option.isSome(projectValue)) return projectValue;
  }
  return yield* Config.option(Config.string(BITBUCKET_CLONE_DIR_ENV_KEY));
});

/** Returns whether a non-empty Bitbucket marker disables restricted Docker options. */
export const isBitbucketPipeline = Effect.fnUntraced(function* (
  projectEnvValues?: Readonly<Record<string, string>>,
) {
  const value = yield* bitbucketCloneDir(projectEnvValues);
  return Option.isSome(value) && value.value.length > 0;
});
