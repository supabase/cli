import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { experimentalStackStart } from "./start.handler.ts";

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
  preparation: Flag.choice("preparation", ["background", "on-demand"] as const).pipe(
    Flag.withDescription("Artifact preparation policy."),
    Flag.withDefault("background" as const),
  ),
  eager: Flag.boolean("eager").pipe(
    Flag.withDescription("Activate all enabled capabilities before returning."),
    Flag.withDefault(false),
  ),
} as const;

export type ExperimentalStackStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const experimentalStackStartCommand = Command.make("start", config).pipe(
  Command.withDescription(
    "Create or resume a managed local Supabase stack from supabase/config.toml. " +
      "Values support explicit env(NAME) references and automatic SUPABASE_* overrides.",
  ),
  Command.withShortDescription("Start a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack start",
      description: "Start the current project stack",
    },
    {
      command: "supabase stack start --stack feature-a --runtime docker",
      description: "Start a named Docker stack",
    },
  ]),
  Command.withHandler((flags) =>
    experimentalStackStart(flags).pipe(
      withCommandTelemetry({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
