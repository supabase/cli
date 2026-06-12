import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyServices } from "./services.handler.ts";
import { legacyServicesRuntimeLayer } from "./services.layers.ts";

const config = {};
export type LegacyServicesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyServicesCommand = Command.make("services", config).pipe(
  Command.withDescription("Show versions of all Supabase services."),
  Command.withShortDescription("Show versions of all Supabase services"),
  Command.withHandler((flags) =>
    legacyServices(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyServicesRuntimeLayer),
);
