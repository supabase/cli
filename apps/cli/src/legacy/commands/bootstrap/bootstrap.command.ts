import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyBootstrapRuntimeLayer } from "./bootstrap.layers.ts";
import { legacyBootstrap } from "./bootstrap.handler.ts";

const config = {
  template: Argument.string("template").pipe(
    Argument.withDescription("Name of the starter template to bootstrap from."),
    Argument.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.withAlias("p"),
    Flag.optional,
  ),
} as const;

export type LegacyBootstrapFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBootstrapCommand = Command.make("bootstrap", config).pipe(
  Command.withDescription("Bootstrap a Supabase project from a starter template."),
  Command.withShortDescription("Bootstrap a Supabase project from a starter template"),
  Command.withHandler((flags) =>
    // Go marks no bootstrap flag `markFlagTelemetrySafe`, so no `safeFlags`.
    legacyBootstrap(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyBootstrapRuntimeLayer),
);
