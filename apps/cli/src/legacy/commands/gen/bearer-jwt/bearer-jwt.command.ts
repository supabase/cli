import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyGenBearerJwt } from "./bearer-jwt.handler.ts";
import { legacyParseBearerJwtExp, legacyParseBearerJwtValidFor } from "./bearer-jwt.flags.ts";

const config = {
  // Go: `cobra.CheckErr(genJWTCmd.MarkFlagRequired("role"))` (`cmd/gen.go:175`) — no
  // `Flag.optional` here, so a missing `--role` fails during argument parsing with
  // the framework's own Go-parity `required flag(s) "role" not set` rendering
  // (`shared/output/normalize-error.ts`'s `MissingOption` case), matching Go's
  // `ValidateRequiredFlags`/`SilenceUsage` behavior (same pattern as `sso add --type`).
  role: Flag.string("role").pipe(Flag.withDescription("Postgres role to use.")),
  // Go's `DefValue` is cosmetically overwritten to "anonymous" (`cmd/gen.go:177`) but the
  // bound variable's real default stays "" — verified against the real binary, an
  // omitted `--sub` never puts a `sub` claim in the token at all.
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
  legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer)),
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
