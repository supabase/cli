import { Flag, GlobalFlag } from "effect/unstable/cli";

/**
 * The TS-only `--output-format` global, accepted on any subcommand.
 *
 * A value-taking global flag must also be registered in `PERSISTENT_VALUE_FLAG_NAMES`
 * (`shared/cli/cobra-flag-groups.ts`), or the pre-parse argv scanners won't consume its value.
 */
export const OutputFormatFlag = GlobalFlag.Setting("output-format")({
  flag: Flag.Literals("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
    Flag.optional,
  ),
});
