import { Flag } from "effect/unstable/cli";

/**
 * cobra auto-registers `--no-descriptions` on the bash/zsh/fish/powershell
 * completion subcommands whenever descriptions are enabled (the default) —
 * `compCmdNoDescFlagName`/`compCmdNoDescFlagDefault`/`compCmdNoDescFlagDesc`
 * in `spf13/cobra@v1.10.2/completions.go:101-103`. Shared across all four
 * leaves rather than redeclared per-file.
 */
export const LegacyCompletionNoDescriptionsFlagDef = Flag.boolean("no-descriptions").pipe(
  Flag.withDescription("disable completion descriptions"),
);
