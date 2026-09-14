import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { genBearerJwt } from "./bearer-jwt.handler.ts";
import { parseBearerJwtExp, parseBearerJwtValidFor } from "./bearer-jwt.flags.ts";

const config = {
  // `--role` stays optional at parse time so a missing value is enforced in
  // the handler instead, after telemetry is wired up — see
  // `GenBearerJwtRoleRequiredError`.
  role: Flag.string("role").pipe(Flag.withDescription("Postgres role to use."), Flag.optional),
  // The displayed default is cosmetically "anonymous" but the real default
  // stays "" — an omitted `--sub` never puts a `sub` claim in the token at
  // all.
  sub: Flag.string("sub").pipe(Flag.withDescription("User ID to impersonate."), Flag.optional),
  exp: Flag.string("exp").pipe(
    Flag.withDescription("Expiry timestamp for this token."),
    Flag.mapTryCatch(
      (value) => parseBearerJwtExp(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    Flag.optional,
  ),
  validFor: Flag.string("valid-for").pipe(
    Flag.withDescription("Validity duration for this token."),
    Flag.withDefault("30m"),
    Flag.mapTryCatch(
      (value) => parseBearerJwtValidFor(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  payload: Flag.string("payload").pipe(
    Flag.withDescription("Custom claims in JSON format."),
    Flag.withDefault("{}"),
  ),
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

export const genBearerJwtCommand = Command.make("bearer-jwt", config).pipe(
  Command.withDescription("Generate a Bearer Auth JWT for accessing Data API"),
  Command.withShortDescription("Generate a Bearer Auth JWT for accessing Data API"),
  Command.withHandler((flags) =>
    genBearerJwt(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(genBearerJwtRuntimeLayer),
);
