import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { loginRuntimeLayer } from "./login.layers.ts";
import { login } from "./login.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../command-internal/command-permissions/model.ts";
import { loginProfile } from "../../command-internal/login-api.layer.ts";
import { cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const config = {
  token: cliFlag("token", Flag.String, {
    description: "Access token to store instead of using the browser login flow.",
    optional: true,
  }),
  name: cliFlag("name", Flag.String, {
    description: "Name to store the token under in your settings.",
    optional: true,
    docs: { default: "built-in token name generator" },
  }),
  noBrowser: cliFlag("no-browser", Flag.Boolean, {
    description: "Print the login URL without opening a browser.",
    default: false,
  }),
} as const;

export type LoginFlags = CliCommand.Command.Config.Infer<typeof config>;

export const loginCommand = makeCommand("login", config).pipe(
  Command.withDescription("Log in to your Supabase account and store an access token for the CLI."),
  Command.withShortDescription("Log in to your Supabase account"),
  withPermissions(
    compose({ operations: [], noApiEffectFlags: ["token", "name", "no-browser"] }, loginProfile),
  ),
  Command.withHandler((flags) =>
    login(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(loginRuntimeLayer),
  withTargetPolicy({
    group: "account",
    consent: "none",
    consentExemptReason: "mints the caller's own access token",
  }),
);
