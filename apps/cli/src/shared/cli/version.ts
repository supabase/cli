// The build scripts replace this symbol with the immutable package version in
// released binaries. It intentionally is not read from the runtime
// environment: source execution must remain an unambiguous development build.
declare const SUPABASE_CLI_VERSION: string | undefined;

export const CLI_VERSION =
  typeof SUPABASE_CLI_VERSION === "string" ? SUPABASE_CLI_VERSION : "0.0.0-dev";
