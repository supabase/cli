import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyStatus } from "./status.handler.ts";

const config = {
  overrideName: Flag.string("override-name").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Override specific variable names."),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
} as const;

export type LegacyStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show status of local Supabase containers."),
  Command.withShortDescription("Show status of local Supabase containers"),
  Command.withExamples([
    {
      command: "supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL",
      description: "Output env vars with custom variable names",
    },
    {
      command: "supabase status -o json",
      description: "Output status as JSON",
    },
  ]),
  Command.withHandler((flags) => legacyStatus(flags)),
);
