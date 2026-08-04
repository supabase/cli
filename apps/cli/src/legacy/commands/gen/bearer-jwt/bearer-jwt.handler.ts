import { Effect, FileSystem, Path } from "effect";
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
  LegacyGenBearerJwtSignError,
} from "./bearer-jwt.errors.ts";
import { legacyResolveBearerJwtSigningKey } from "./bearer-jwt.signing-key.ts";

/**
 * Go's `gen bearer-jwt` (`apps/cli-go/cmd/gen.go:132-143` + `internal/gen/bearerjwt/bearerjwt.go`):
 * fully local, no Docker, no network. Order matches Go exactly:
 *
 *   1. `parseClaims` (`cmd/gen.go:136-141`, ported as {@link legacyBuildBearerJwtClaims} +
 *      {@link legacyMergeBearerJwtPayload}) — runs entirely BEFORE `bearerjwt.Run` is even
 *      called, so a malformed `--payload` fails before any config load or signing-key
 *      prompt ever happens.
 *   2. `bearerjwt.Run`'s `flags.LoadConfig` (`bearerjwt.go:20`) — loads the project `.env`
 *      cascade as part of `Config.Load` (see SIDE_EFFECTS.md); ported via
 *      `legacyLoadProjectEnv` for the same failure mode, even though this command has no
 *      `.env`-sourced prompt of its own to gate.
 *   3. `getSigningKey` (`bearerjwt.go:23`, ported as {@link legacyResolveBearerJwtSigningKey}
 *      in `bearer-jwt.signing-key.ts`) — resolves a JWK, prompting interactively when
 *      needed.
 *   4. `config.GenerateAsymmetricJWT` (`bearerjwt.go:27`, ported as
 *      `legacySignJwtWithJwk` in `legacy-go-jwt.ts`) — signs the claims.
 *   5. `fmt.Fprintln(w, token)` (`bearerjwt.go:31`) — the token, then exactly one
 *      trailing newline, on stdout. Nothing else ever reaches stdout; every prompt and
 *      error goes to stderr.
 *
 * Unconditional on `--output-format`, matching `gen signing-key`'s own established
 * precedent (`signing-key.handler.ts`): the raw token IS the payload — there is no
 * separate human/machine shape to choose between, and Go's own command has no
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const baseClaims = legacyBuildBearerJwtClaims({
      role: flags.role,
      sub: flags.sub,
      expiresAt: flags.exp,
      validForSeconds: flags.validFor,
      nowSeconds,
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
