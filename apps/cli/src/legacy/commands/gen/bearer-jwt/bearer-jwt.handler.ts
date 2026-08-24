import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacySignJwtWithJwk } from "../../../shared/legacy-go-jwt.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyGenBearerJwtFlags } from "./bearer-jwt.command.ts";
import {
  legacyBuildBearerJwtClaims,
  legacyEncodeBearerJwtClaims,
  legacyMergeBearerJwtPayload,
} from "./bearer-jwt.claims.ts";
import {
  legacyBearerJwtErrorMessage,
  LegacyGenBearerJwtPayloadError,
  LegacyGenBearerJwtRoleRequiredError,
  LegacyGenBearerJwtSignError,
} from "./bearer-jwt.errors.ts";
import { legacyResolveBearerJwtSigningKey } from "./bearer-jwt.signing-key.ts";

/**
 * `gen bearer-jwt`: fully local, no Docker, no network. Established order:
 *
 *   0. Required-flag validation (ported as the `flags.role` check just
 *      below) — runs after the telemetry context is installed but before
 *      claims parsing, so a missing `--role` still flushes `telemetry.json`
 *      (see {@link LegacyGenBearerJwtRoleRequiredError}).
 *   1. Claims parsing (ported as {@link legacyBuildBearerJwtClaims} +
 *      {@link legacyMergeBearerJwtPayload}) — runs entirely BEFORE the rest of
 *      the command runs, so a malformed `--payload` fails before any config
 *      load or signing-key prompt ever happens.
 *   2. Project config load — loads the project `.env` cascade (see
 *      SIDE_EFFECTS.md); ported via `legacyLoadProjectEnv` for the same
 *      failure mode, even though this command has no `.env`-sourced prompt
 *      of its own to gate.
 *   3. Signing-key resolution (ported as
 *      {@link legacyResolveBearerJwtSigningKey} in `bearer-jwt.signing-key.ts`)
 *      — resolves a JWK, prompting interactively when needed.
 *   4. Signing (ported as `legacySignJwtWithJwk` in `legacy-go-jwt.ts`) —
 *      signs the claims.
 *   5. The token, then exactly one trailing newline, on stdout. Nothing
 *      else ever reaches stdout; every prompt and error goes to stderr.
 *
 * Unconditional on `--output-format`, matching `gen signing-key`'s own established
 * precedent (`signing-key.handler.ts`): the raw token IS the payload — there is no
 * separate human/machine shape to choose between, and this command has no
 * `-o`/`--output-format` concept at all.
 */
export const legacyGenBearerJwt = Effect.fn("legacy.gen.bearer-jwt")(function* (
  flags: LegacyGenBearerJwtFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* Effect.gen(function* () {
    if (Option.isNone(flags.role)) {
      return yield* new LegacyGenBearerJwtRoleRequiredError({
        message: `required flag(s) "role" not set`,
      });
    }
    const role = flags.role.value;

    // Built directly from `Date.now()`'s integer milliseconds, NOT floored to whole
    // seconds — see `LegacyBearerJwtClaimsInput.nowInstant`'s own doc comment for why
    // pre-flooring here would shorten a sub-second `--valid-for`'s effective lifetime.
    const nowMs = yield* Clock.currentTimeMillis;
    const nowInstant = {
      wholeSeconds: Math.floor(nowMs / 1000),
      nanos: (nowMs % 1000) * 1_000_000,
    };
    const baseClaims = legacyBuildBearerJwtClaims({
      role,
      sub: flags.sub,
      expiresAt: flags.exp,
      validForSeconds: flags.validFor,
      nowInstant,
    });
    const claims = yield* Effect.try({
      try: () => legacyMergeBearerJwtPayload(baseClaims, flags.payload),
      catch: (cause) =>
        new LegacyGenBearerJwtPayloadError({
          message: `failed to parse payload: ${legacyBearerJwtErrorMessage(cause)}`,
        }),
    });

    yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    const jwk = yield* legacyResolveBearerJwtSigningKey(cliConfig.workdir);

    const payloadJson = legacyEncodeBearerJwtClaims(claims);
    const token = yield* Effect.try({
      try: () => legacySignJwtWithJwk(jwk, payloadJson),
      catch: (cause) =>
        new LegacyGenBearerJwtSignError({ message: legacyBearerJwtErrorMessage(cause) }),
    });

    yield* output.raw(`${token}\n`, "stdout");
  }).pipe(Effect.ensuring(telemetryState.flush));
});
