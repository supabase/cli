import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyServices } from "./services.handler.ts";

const config = {};
export type LegacyServicesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyServicesCommand = Command.make("services", config).pipe(
  Command.withDescription("Show versions of all Supabase services."),
  Command.withShortDescription("Show versions of all Supabase services"),
  Command.withHandler((_flags) => legacyServices(_flags)),
);
