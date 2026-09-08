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
 * `gen bearer-jwt`: fully local, no Docker, no network. Established order:
 *
 *   0. Required-flag validation (ported as the `flags.role` check just
 *      below) — runs after the telemetry context is installed but before
 *      claims parsing, so a missing `--role` still flushes `telemetry.json`
 *      (see {@link GenBearerJwtRoleRequiredError}).
 *   1. Claims parsing (ported as {@link buildBearerJwtClaims} +
 *      {@link mergeBearerJwtPayload}) — runs entirely BEFORE the rest of
 *      the command runs, so a malformed `--payload` fails before any config
 *      load or signing-key prompt ever happens.
 *   2. Project config load — loads the project `.env` cascade (see
 *      SIDE_EFFECTS.md); ported via `loadProjectEnv` for the same
 *      failure mode, even though this command has no `.env`-sourced prompt
 *      of its own to gate.
 *   3. Signing-key resolution (ported as
 *      {@link resolveBearerJwtSigningKey} in `bearer-jwt.signing-key.ts`)
 *      — resolves a JWK, prompting interactively when needed.
 *   4. Signing (ported as `signJwtWithJwk` in `go-jwt.ts`) —
 *      signs the claims.
 *   5. The token, then exactly one trailing newline, on stdout. Nothing
 *      else ever reaches stdout; every prompt and error goes to stderr.
 *
 * Unconditional on `--output-format`, matching `gen signing-key`'s own established
 * precedent (`signing-key.handler.ts`): the raw token IS the payload — there is no
 * separate human/machine shape to choose between, and this command has no
 * `-o`/`--output-format` concept at all.
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

    // Built directly from `Date.now()`'s integer milliseconds, NOT floored to whole
    // seconds — see `BearerJwtClaimsInput.nowInstant`'s own doc comment for why
    // pre-flooring here would shorten a sub-second `--valid-for`'s effective lifetime.
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
