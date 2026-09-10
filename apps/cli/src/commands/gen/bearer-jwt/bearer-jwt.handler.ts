import { Effect, FileSystem, Option, Path } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import { signJwtWithJwk } from "../../../command-internal/go-jwt.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { GenBearerJwtFlags } from "./bearer-jwt.command.ts";
import {
  buildBearerJwtClaims,
  encodeBearerJwtClaims,
  mergeBearerJwtPayload,
} from "./bearer-jwt.claims.ts";
import {
  bearerJwtErrorMessage,
  GenBearerJwtPayloadError,
  GenBearerJwtRoleRequiredError,
  GenBearerJwtSignError,
} from "./bearer-jwt.errors.ts";
import { resolveBearerJwtSigningKey } from "./bearer-jwt.signing-key.ts";

/**
 * `gen bearer-jwt` is fully local (no Docker, no network).
 *
 * Required-flag validation and claims-payload parsing both run before the
 * project config load and signing-key resolution, so a missing `--role` or a
 * malformed `--payload` fails before any config load or signing-key prompt.
 *
 * Output is unconditional on `--output-format`: the raw token is the only
 * payload, written to stdout with one trailing newline; every prompt and
 * error goes to stderr.
 */
export const genBearerJwt = Effect.fn("gen.bearer-jwt")(function* (flags: GenBearerJwtFlags) {
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* Effect.gen(function* () {
    if (Option.isNone(flags.role)) {
      return yield* Effect.fail(
        new GenBearerJwtRoleRequiredError({
          message: `required flag(s) "role" not set`,
        }),
      );
    }
    const role = flags.role.value;

    // Not floored to whole seconds — see `BearerJwtClaimsInput.nowInstant`
    // for why pre-flooring would shorten a sub-second `--valid-for`.
    const nowMs = Date.now();
    const nowInstant = {
      wholeSeconds: Math.floor(nowMs / 1000),
      nanos: (nowMs % 1000) * 1_000_000,
    };
    const baseClaims = buildBearerJwtClaims({
      role,
      sub: flags.sub,
      expiresAt: flags.exp,
      validForSeconds: flags.validFor,
      nowInstant,
    });
    const claims = yield* Effect.try({
      try: () => mergeBearerJwtPayload(baseClaims, flags.payload),
      catch: (cause) =>
        new GenBearerJwtPayloadError({
          message: `failed to parse payload: ${bearerJwtErrorMessage(cause)}`,
        }),
    });

    yield* loadProjectEnv(fs, path, cliSettings.workdir);
    const jwk = yield* resolveBearerJwtSigningKey(cliSettings.workdir);

    const payloadJson = encodeBearerJwtClaims(claims);
    const token = yield* Effect.try({
      try: () => signJwtWithJwk(jwk, payloadJson),
      catch: (cause) => new GenBearerJwtSignError({ message: bearerJwtErrorMessage(cause) }),
    });

    yield* output.raw(`${token}\n`, "stdout");
  }).pipe(Effect.ensuring(telemetryState.flush));
});
