import { Flag } from "effect/unstable/cli";

/**
 * cobra auto-registers `--no-descriptions` on the bash/zsh/fish/powershell
 * completion subcommands whenever descriptions are enabled (the default) —
 * `compCmdNoDescFlagName`/`compCmdNoDescFlagDefault`/`compCmdNoDescFlagDesc`
 * in `spf13/cobra@v1.10.2/completions.go:101-103`. Shared across all four
 * leaves rather than redeclared per-file.
 *
 * `Flag.boolean` auto-derives a `--no-<name>` negation, so this flag name
 * produces `--no-no-descriptions` as a working (if odd) way to re-enable
 * descriptions. Harmless — it resolves to the same `false` default — and
 * not something cobra does, so there's no parity requirement to remove it.
 */
export const LegacyCompletionNoDescriptionsFlagDef = Flag.boolean("no-descriptions").pipe(
  Flag.withDescription("disable completion descriptions"),
);
