// The build scripts replace this symbol with the immutable package version in
// released binaries. It intentionally is not read from the runtime
// environment: source execution must remain an unambiguous development build.
declare const SUPABASE_CLI_VERSION: string | undefined;

export const CLI_VERSION =
  typeof SUPABASE_CLI_VERSION === "string" ? SUPABASE_CLI_VERSION : "0.0.0-dev";

/**
 * Where a user goes to get a newer CLI. There is no self-update command, so
 * anything telling a user to upgrade has to send them here rather than name an
 * invocation.
 */
export const CLI_UPGRADE_GUIDE_URL =
  "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli";
