import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { CAPABILITY_NAMES } from "@supabase/stack/effect";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackPrepare } from "./prepare.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(Flag.withDescription("Name this stack."), Flag.optional),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Open an existing stack by id."),
    Flag.optional,
  ),
  runtime: Flag.choice("runtime", ["auto", "docker", "native"] as const).pipe(
    Flag.withDescription("Runtime to use for a new stack."),
    Flag.withDefault("auto" as const),
  ),
  capability: Flag.atMost(
    Flag.choice("capability", CAPABILITY_NAMES),
    CAPABILITY_NAMES.length,
  ).pipe(Flag.withDescription("Capability to prepare (repeatable).")),
} as const;

export type LegacyExperimentalStackPrepareFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyExperimentalStackPrepareCommand = Command.make("prepare", config).pipe(
  Command.withDescription("Prepare artifacts for a managed local Supabase stack."),
  Command.withShortDescription("Prepare a managed local stack"),
  Command.withExamples([
    {
      command: "supabase experimental stack prepare",
      description: "Prepare all enabled stack capabilities",
    },
    {
      command: "supabase experimental stack prepare --stack feature-a --capability rest",
      description: "Prepare one capability in a named stack",
    },
  ]),
  Command.withHandler((flags) =>
    legacyExperimentalStackPrepare(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
