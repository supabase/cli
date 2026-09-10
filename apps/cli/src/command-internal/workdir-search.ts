/**
 * Whether a config load should climb ancestor directories looking for
 * `supabase/config.{toml,json}` beyond the resolved
 * `CommandSettings.workdir`.
 *
 * 1. An explicit workdir is authoritative — letting `loadCliConfig` climb
 *    again on top of it would let an unrelated ancestor project's config
 *    win (this is the CLI-2285 bug).
 * 2. A defaulted (unset) workdir must still climb inside `loadCliConfig`,
 *    because the workdir's own default resolution (`resolveWorkdir` in
 *    `command-settings.layer.ts`) only probes `supabase/config.toml` — a
 *    `config.json`-only project invoked from a subdirectory relies on this
 *    second, format-aware climb to be found.
 * 3. A caller that already passes `tomlOnly: true` to `loadCliConfig` (e.g.
 *    `local-project-context.ts`, `gen.signing-keys-config.ts`,
 *    `shared/functions/serve.ts`'s `goConfigCompat` branch) doesn't need
 *    this helper — for those, the default-workdir climb and the second
 *    climb are checking the exact same thing, so they already correctly
 *    pass `search: false` unconditionally instead.
 * 4. Passing this predicate is only half the contract. A JSON-capable load
 *    that also **tolerates** a `null` result must either hard-fail when
 *    `explicitWorkdir` is true (`config diff`/`push`/`pull`, `gen types`,
 *    `storage ls|mv|rm|cp`, `seed buckets`) or document why falling back is
 *    right for it. The three documented exceptions, all of which
 *    intentionally scaffold into or report on a bare directory: `functions
 *    new` (templates use embedded defaults — port/publishable key),
 *    `compute new` (`compute new api --workdir ./bare-dir`
 *    must create the entry there), and `seedBucketsRun`'s own load,
 *    which is only reached by the standalone `seed buckets` command —
 *    `start` and `db reset` pass `resolvedConfig` and never load config here
 *    at all.
 */
export function shouldSearchAncestors(cliSettings: { readonly explicitWorkdir: boolean }): boolean {
  return !cliSettings.explicitWorkdir;
}
