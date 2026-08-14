import { Flag, GlobalFlag } from "effect/unstable/cli";

/**
 * The TS-only `--output-format` global (no Go counterpart), accepted on any
 * subcommand.
 *
 * It takes a value, so its token is registered in `globalFlagsWithValues`
 * (`shared/cli/run.ts`) and its name in `PERSISTENT_VALUE_FLAG_NAMES`
 * (`shared/cli/cobra-flag-groups.ts`) — any value-taking global added here
 * needs both, or the raw-argv pflag scanners that run for
 * `--help`/`--version`/bare-group invocations will not consume its following
 * token. See `LEGACY_GLOBAL_FLAGS` (`shared/legacy/global-flags.ts`) for what
 * silently breaks when they drift.
 */
export const OutputFormatFlag = GlobalFlag.setting("output-format")({
  flag: Flag.choice("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
    Flag.optional,
  ),
});
