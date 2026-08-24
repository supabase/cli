// `CLI_VERSION` is injected at compile time by the build scripts. Source
// execution uses a visible development sentinel.
export const CLI_VERSION = process.env.SUPABASE_CLI_VERSION ?? "0.0.0-dev";
