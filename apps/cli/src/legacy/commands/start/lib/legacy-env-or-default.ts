/**
 * `envOrDefault(key, def)`: env-var-if-set-else-default — an env var that is
 * SET but empty is used verbatim (unlike `legacy-local-config-values.ts`'s
 * `envOverride`, which treats an empty resolved value as unset). `projectEnvValues`
 * is the merged (dotenv + ambient shell, ambient-wins) map supplied by the start command's
 * Effect config boundary; `??` only skips a `null`/`undefined` operand, never an empty string, so
 * this naturally reproduces "set, even if empty" semantics without a separate presence check.
 * No `SUPABASE_` prefix and no `env(VAR)` indirection — this reads the resolved map directly,
 * bypassing the decode-hook chain those only apply to.
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
  return projectEnvValues?.[key] ?? def;
}
