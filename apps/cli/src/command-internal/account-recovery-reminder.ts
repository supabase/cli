import process from "node:process";
import { Config, ConfigProvider, Effect, Option } from "effect";
import type { OutputFormat } from "../shared/output/types.ts";
import { red, yellow } from "./colors.ts";
import {
  hasRootHelpOrVersionFlag,
  lastGlobalFlagValue,
  rootFlagTokens,
} from "../shared/cli/run.ts";

type MockRecoveryState = "exhausted" | "missing" | "low";

const accountSecurityAccent = (state: MockRecoveryState, text: string): string =>
  state === "exhausted" ? red(text) : yellow(text);

const message = (state: MockRecoveryState): string => {
  const heading = accountSecurityAccent(state, "⚠ Secure your account");
  const rail = accountSecurityAccent(state, "│");
  switch (state) {
    case "exhausted":
      return `${heading}\n${rail} Your recovery codes are exhausted.\n${rail} Generate and save a new set:\n${rail} https://supabase.com/dashboard/account/security`;
    case "missing":
      return `${heading}\n${rail} You have no recovery codes.\n${rail} Generate and save a set:\n${rail} https://supabase.com/dashboard/account/security`;
    case "low":
      return `${heading}\n${rail} You have few recovery codes left.\n${rail} Generate and save a new set:\n${rail} https://supabase.com/dashboard/account/security`;
  }
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
    yield* Effect.sync(() => process.stderr.write(`${message(state)}\n`));
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    Effect.withSpan("AccountRecoveryReminder.show"),
    Effect.ignoreCause,
  );
