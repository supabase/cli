import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import type * as CliCommand from "effect/unstable/cli/Command";
import { services } from "./services.handler.ts";
import { servicesRuntimeLayer } from "./services.layers.ts";

const config = {};
export type ServicesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const servicesCommand = Command.make("services", config).pipe(
  Command.withDescription("Show versions of all Supabase services."),
  Command.withShortDescription("Show versions of all Supabase services"),
  Command.withHandler((flags) =>
    services(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(servicesRuntimeLayer),
);
