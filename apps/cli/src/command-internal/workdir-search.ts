/**
 * Whether a config load should climb ancestor directories for `supabase/config.{toml,json}`
 * beyond `CommandSettings.workdir`.
 *
 * An explicit workdir is authoritative and never climbs, so an unrelated ancestor project's
 * config can't win. A defaulted workdir still climbs, since its own default resolution only
 * probes `config.toml`.
 */
export function shouldSearchAncestors(cliSettings: { readonly explicitWorkdir: boolean }): boolean {
  return !cliSettings.explicitWorkdir;
}
