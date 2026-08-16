import { Effect, Option } from "effect";
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

/**
 * `next`-shell counterpart of `LegacyRemoteFlag` same CLI flag name and semantics,
 * but a distinct `GlobalFlag.setting` instance because `legacy/` and `next/`
 * command trees are fully isolated and each registers its own global-flag set via
 * `Command.withGlobalFlags`. Wired into `next/config/resolve-project-ref.ts`.
 */
export const RemoteFlag = GlobalFlag.setting("remote")({
  flag: Flag.string("remote").pipe(
    Flag.withDescription("target the named [remotes.<name>] entry from supabase/config.toml"),
    Flag.optional,
  ),
});

/**
 * `RemoteFlag`, read via `Effect.serviceOption` so a caller that hasn't
 * wired the global-flag context gets `None` instead of a missing-service defect.
 * Production always provides it through `Command.withGlobalFlags` at the CLI root.
 */
export const resolveRemoteFlag = Effect.map(Effect.serviceOption(RemoteFlag), Option.flatten);
