// This constant is injected at compile time by `apps/cli/scripts/build.ts`
// via `bun build --define "process.env.SUPABASE_CLI_VERSION=..."`.
// At runtime outside a compiled SFE (dev, tests), we fall back to the
// env var or a sentinel so that bugs are visible in CLI output.
export const CLI_VERSION = process.env.SUPABASE_CLI_VERSION ?? "0.0.0-dev";
