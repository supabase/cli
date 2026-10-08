import { Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { cliConfigProviderLayer } from "../../shared/config/cli-config-provider.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { bootstrapRuntimeLayer } from "./bootstrap.layers.ts";
import { bootstrap } from "./bootstrap.handler.ts";

const config = {
  template: Argument.string("template").pipe(
    Argument.withDescription("Name of the starter template to bootstrap from."),
    Argument.optional,
  ),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Password to your remote Postgres database.",
  }),
} as const;

export type BootstrapFlags = CliCommand.Command.Config.Infer<typeof config>;

export const bootstrapCommand = Command.make("bootstrap", config).pipe(
  Command.withDescription("Bootstrap a Supabase project from a starter template."),
  Command.withShortDescription("Bootstrap a Supabase project from a starter template"),
  Command.withHandler((flags) =>
    // Go marks no bootstrap flag `markFlagTelemetrySafe`, so no `safeFlags`.
    bootstrap(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(bootstrapRuntimeLayer.pipe(Layer.provideMerge(cliConfigProviderLayer))),
  withCliConfigFlags(config),
);
