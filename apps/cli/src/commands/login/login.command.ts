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

const config = {
  token: Flag.String("token").pipe(
    Flag.withDescription("Use provided token instead of automatic login flow."),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("Name that will be used to store token in your settings."),
    Flag.optional,
  ),
  noBrowser: Flag.Boolean("no-browser").pipe(
    Flag.withDescription("Do not open browser automatically."),
    Flag.withDefault(false),
  ),
} as const;

export type LoginFlags = CliCommand.Command.Config.Infer<typeof config>;

export const loginCommand = Command.make("login", config).pipe(
  Command.withDescription("Authenticate using an access token."),
  Command.withShortDescription("Authenticate using an access token"),
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
