import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyGenBearerJwt } from "./bearer-jwt.handler.ts";
import { legacyParseBearerJwtExp, legacyParseBearerJwtValidFor } from "./bearer-jwt.flags.ts";

const config = {
  // `--role` is required, but required-flag validation must run AFTER the
  // telemetry context is installed and flushed on the return path, so a
  // missing `--role` must still flush telemetry. The framework's own
  // `MissingOption` parse-time rejection (`normalize-error.ts`) would
  // short-circuit before this command's handler — and its
  // `Effect.ensuring(telemetryState.flush)` — ever runs, so `role` stays
  // optional at parse time and presence is enforced in the handler
  // instead, same established pattern as `vanity-subdomains activate`'s
  // `--desired-subdomain` (`activate.command.ts`/`activate.handler.ts`).
  role: Flag.string("role").pipe(Flag.withDescription("Postgres role to use."), Flag.optional),
  // The displayed default is cosmetically "anonymous" but the real default
  // stays "" — an omitted `--sub` never puts a `sub` claim in the token at
  // all.
  sub: Flag.string("sub").pipe(Flag.withDescription("User ID to impersonate."), Flag.optional),
  exp: Flag.string("exp").pipe(
    Flag.withDescription("Expiry timestamp for this token."),
    Flag.mapTryCatch(
      (value) => legacyParseBearerJwtExp(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
    Flag.optional,
  ),
  validFor: Flag.string("valid-for").pipe(
    Flag.withDescription("Validity duration for this token."),
    Flag.withDefault("30m"),
    Flag.mapTryCatch(
      (value) => legacyParseBearerJwtValidFor(value),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  payload: Flag.string("payload").pipe(
    Flag.withDescription("Custom claims in JSON format."),
    Flag.withDefault("{}"),
  ),
} as const;

export type LegacyGenBearerJwtFlags = CliCommand.Command.Config.Infer<typeof config>;

const legacyGenBearerJwtRuntimeLayer = Layer.mergeAll(
  legacyDebugLoggerLayer,
  legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer)),
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["gen", "bearer-jwt"]),
  // Branch A's stdin JWK prompt and Branch B's stdin kid prompt (`getSigningKey`,
  // `bearerjwt.go:37-68`) both read piped stdin even on a non-TTY, same as
  // `gen signing-key`'s overwrite confirmation.
  stdinLayer,
);

export const legacyGenBearerJwtCommand = Command.make("bearer-jwt", config).pipe(
  Command.withDescription("Generate a Bearer Auth JWT for accessing Data API"),
  Command.withShortDescription("Generate a Bearer Auth JWT for accessing Data API"),
  Command.withHandler((flags) =>
    legacyGenBearerJwt(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyGenBearerJwtRuntimeLayer),
);
