import process from "node:process";
import { Config, ConfigProvider, Effect, Option } from "effect";
import type { OutputFormat } from "../shared/output/types.ts";
import {
  hasRootHelpOrVersionFlag,
  lastGlobalFlagValue,
  rootFlagTokens,
} from "../shared/cli/run.ts";

type MockRecoveryState = "exhausted" | "missing" | "low";

const messages: Readonly<Record<MockRecoveryState, string>> = {
  exhausted:
    "[mock account security] Your recovery codes are exhausted. Open https://supabase.com/dashboard/account/security to generate and save new codes.",
  missing:
    "[mock account security] You have no recovery codes. Open https://supabase.com/dashboard/account/security to generate and save codes.",
  low: "[mock account security] You have few recovery codes left. Open https://supabase.com/dashboard/account/security to generate and save new codes.",
};

interface ReminderContext {
  readonly cleanShowHelp: boolean;
  readonly delegatedToGo: boolean;
  readonly outputFormat: OutputFormat;
  readonly detectedAgent: boolean;
  readonly isValueTakingFlagToken: (token: string) => boolean;
}

/** Emits a mock-only account recovery reminder after an interactive, successful command. */
export const accountRecoveryReminderHook = (
  args: ReadonlyArray<string>,
  info: ReminderContext,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Config.string("SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK").pipe(
      Config.withDefault(""),
    );
    if (state !== "exhausted" && state !== "missing" && state !== "low") return;
    if (info.cleanShowHelp || info.delegatedToGo || info.outputFormat !== "text") return;
    const ci = yield* Config.option(Config.string("CI"));
    const githubActions = yield* Config.option(Config.string("GITHUB_ACTIONS"));
    if (Option.isSome(ci) || Option.isSome(githubActions)) return;
    if (
      info.detectedAgent ||
      lastGlobalFlagValue(args, "--agent", info.isValueTakingFlagToken) === "yes"
    )
      return;
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) return;
    if (hasRootHelpOrVersionFlag(args, info.isValueTakingFlagToken)) return;
    if (lastGlobalFlagValue(args, "--output", info.isValueTakingFlagToken) !== undefined) return;
    for (const { token } of rootFlagTokens(args, info.isValueTakingFlagToken)) {
      if (token === "-o" || token.startsWith("-o=")) return;
    }
    yield* Effect.sync(() => process.stderr.write(`${messages[state]}\n`));
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    Effect.withSpan("AccountRecoveryReminder.show"),
    Effect.ignoreCause,
  );
