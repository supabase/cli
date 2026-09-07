import { Flag, GlobalFlag } from "effect/unstable/cli";

/**
 * The TS-only `--output-format` global (no Go counterpart), accepted on any
 * subcommand.
 *
 * It takes a value, so its name is registered in
 * `PERSISTENT_VALUE_FLAG_NAMES` (`shared/cli/cobra-flag-groups.ts`) — the
 * pre-parse scanners derive their token set from it
 * (`GLOBAL_VALUE_FLAG_TOKENS`), so that one edit covers any value-taking
 * global added here. Without it, the raw-argv scanners that run for
 * `--help`/`--version`/bare-group invocations will not consume its following
 * token. See `LEGACY_GLOBAL_FLAGS` (`shared/legacy/global-flags.ts`) for what
 * silently breaks when a flag is missing from the shared registry.
 */
export const OutputFormatFlag = GlobalFlag.setting("output-format")({
  flag: Flag.choice("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
    Flag.optional,
  ),
});
