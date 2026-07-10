/**
 * Go's `envOrDefault(key, def string) string` (`start.go:1466-1471`):
 * `os.LookupEnv`-if-set-else-default — an env var that is SET but empty is
 * used verbatim (unlike `legacy-local-config-values.ts`'s `envOverride`,
 * which treats an empty resolved value as unset). `projectEnvValues` mirrors
 * that module's own merged (dotenv + ambient shell, ambient-wins) map;
 * `??` only skips a `null`/`undefined` operand, never an empty string, so
 * this naturally reproduces `LookupEnv`'s "ok if set, even if empty"
 * semantics without a separate presence check. No `SUPABASE_` prefix and no
 * `env(VAR)` indirection — Go's raw `os.LookupEnv` here bypasses the
 * mapstructure decode-hook chain those only apply to.
 *
 * Hoisted here (`start/lib/`, the `start` command family's shared root) per
 * `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule: Storage's
 * vector-bucket env (`services/storage.service.ts`) and Kong's
 * `KONG_NGINX_WORKER_PROCESSES` (`services/kong.service.ts`) both need this
 * exact env/dotenv-vs-default derivation.
 */
export function legacyEnvOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string {
  return projectEnvValues?.[key] ?? process.env[key] ?? def;
}
