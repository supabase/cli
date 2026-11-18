import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { genBearerJwt } from "./bearer-jwt.handler.ts";
import { parseBearerJwtExp, parseBearerJwtValidFor } from "./bearer-jwt.flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  // `--role` stays optional at parse time so a missing value is enforced in
  // the handler instead, after telemetry is wired up — see
  // `GenBearerJwtRoleRequiredError`.
  role: cliFlag("role", Flag.String, {
    description: "Postgres role the token acts as.",
    optional: true,
    docs: { required: true },
  }),
  // The displayed default is cosmetically "anonymous" but the real default
  // stays "" — an omitted `--sub` never puts a `sub` claim in the token at
  // all.
  sub: cliFlag("sub", Flag.String, {
    description: "User ID to impersonate, set as the `sub` claim.",
    optional: true,
    docs: { default: "anonymous" },
  }),
  exp: cliFlag("exp", Flag.String, {
    description: "Expiry timestamp of the token.",
    parse: Flag.mapTryCatch(
      (value) => parseBearerJwtExp(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    optional: true,
  }),
  validFor: cliFlag("valid-for", Flag.String, {
    description: "How long the token stays valid, such as `30m`.",
    parse: Flag.mapTryCatch(
      (value) => parseBearerJwtValidFor(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    default: parseBearerJwtValidFor("30m"),
    docs: { default: "30m0s" },
  }),
  payload: cliFlag("payload", Flag.String, {
    description: "Custom claims to add, as a JSON object.",
    default: "{}",
  }),
} as const;

export type GenBearerJwtFlags = CliCommand.Command.Config.Infer<typeof config>;

const genBearerJwtRuntimeLayer = Layer.mergeAll(
  debugLoggerLayer,
  commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)),
  telemetryStateLayer,
  commandRuntimeLayer(["gen", "bearer-jwt"]),
  // The stdin JWK/kid prompts (`getSigningKey`) read piped stdin even on a
  // non-TTY, same as `gen signing-key`'s overwrite confirmation.
  stdinLayer,
);

export const genBearerJwtCommand = makeCommand("bearer-jwt", config).pipe(
  Command.withDescription(
    "Create a signed JWT for a Postgres role, for calling the Data API. The token is signed locally with a JWT signing key.\n\nSet the claims with `--sub` and `--payload`, and the lifetime with `--valid-for` or `--exp`.",
  ),
  Command.withShortDescription("Generate a Bearer Auth JWT for the Data API"),
  Command.withExamples([
    {
      command: "supabase gen bearer-jwt --role authenticated --sub <user-id>",
      description: "Generate a token for an authenticated user",
    },
    {
      command: "supabase gen bearer-jwt --role service_role --valid-for 1h",
      description: "Generate a service role token valid for one hour",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: ["role", "sub", "exp", "valid-for", "payload"],
  }),
  Command.withHandler((flags) =>
    genBearerJwt(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(genBearerJwtRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
