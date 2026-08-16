import { V1BulkCreateSecretsInput } from "@supabase/api/effect";
import { parse as parseDotenv } from "dotenv";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyInvalidSecretPairError,
  LegacySecretsEnvFileOpenError,
  LegacySecretsEnvFileParseError,
  LegacySecretsNoArgumentsError,
  LegacySecretsSetInputError,
  LegacySecretsSetNetworkError,
  LegacySecretsSetUnexpectedStatusError,
} from "../secrets.errors.ts";
import type { LegacySecretsSetFlags } from "./set.command.ts";

const mapSetError = mapLegacyHttpError({
  networkError: LegacySecretsSetNetworkError,
  statusError: LegacySecretsSetUnexpectedStatusError,
  networkMessage: (cause) => `failed to set secrets: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error setting project secrets: ${body}`,
});

export const legacySecretsSet = Effect.fn("legacy.secrets.set")(function* (
  flags: LegacySecretsSetFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // Explicit inputs only. `[edge_runtime.secrets]` from `supabase/config.toml`
    // is a local-dev input (`functions serve`) and is deliberately NOT merged
    // into remote uploads: the Go CLI seeded every request with it, so
    // `secrets set BAR=bar` silently pushed unrelated config entries too
    // (supabase/supabase#45242). See `docs/go-cli-divergences.md`.
    const merged = new Map<string, string>();

    // Source 1: --env-file entries.
    if (Option.isSome(flags.envFile)) {
      const rawPath = flags.envFile.value;
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(runtimeInfo.cwd, rawPath);
      const content = yield* fs.readFileString(absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new LegacySecretsEnvFileOpenError({
              message: `failed to open env file: ${String(cause)}`,
              reason:
                cause.reason._tag === "NotFound"
                  ? "not_found"
                  : cause.reason._tag === "PermissionDenied"
                    ? "permission"
                    : "other",
            }),
        ),
      );
      let parsed: Record<string, string>;
      try {
        parsed = parseDotenv(content);
      } catch (cause) {
        return yield* Effect.fail(
          new LegacySecretsEnvFileParseError({
            message: `failed to parse env file: ${String(cause)}`,
          }),
        );
      }
      for (const [name, value] of Object.entries(parsed)) {
        merged.set(name, value);
      }
    }

    // Source 2: positional NAME=VALUE pairs override env-file entries.
    for (const pair of flags.secrets) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        return yield* Effect.fail(
          new LegacyInvalidSecretPairError({
            pair,
            message: `Invalid secret pair: ${pair}. Must be NAME=VALUE.`,
          }),
        );
      }
      merged.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    // Filter SUPABASE_-prefixed entries with stderr warning (Go `set.go:67-71`).
    // The API rejects these names server-side anyway (`@supabase/api`'s schema
    // also rejects them via regex), so the filter MUST happen client-side
    // before any request is built — otherwise we'd surface a SchemaError instead.
    const body: Array<{ name: string; value: string }> = [];
    for (const [name, value] of merged) {
      if (name.startsWith("SUPABASE_")) {
        yield* output.raw(`Env name cannot start with SUPABASE_, skipping: ${name}\n`, "stderr");
        continue;
      }
      body.push({ name, value });
    }

    if (body.length === 0) {
      return yield* Effect.fail(
        new LegacySecretsNoArgumentsError({
          message: "No arguments found. Use --env-file to read from a .env file.",
        }),
      );
    }

    // The Management API caps a single bulk-create request at 100 secrets
    // (`V1BulkCreateSecretsInput`'s `isMaxLength(100)` check in `@supabase/api`).
    // Go issues one unbatched request (`internal/secrets/set/set.go`), so against
    // the capped API a >100-entry env file would be rejected wholesale; split into
    // batches of at most 100 so large env files still upload.
    const SECRETS_PER_REQUEST = 100;
    const batches: Array<typeof body> = [];
    for (let i = 0; i < body.length; i += SECRETS_PER_REQUEST) {
      batches.push(body.slice(i, i + SECRETS_PER_REQUEST));
    }

    // Validate every batch (per-entry name/value constraints and the 100-item
    // cap) before sending any request. Without this, a schema-invalid entry in a
    // later batch would only surface after earlier batches had already been
    // uploaded, leaving the project partially updated. Decoding fails with the
    // same `SchemaError` `bulkCreateSecrets` raises. This validation is wholly
    // user-derived, so keep it distinct from response-schema decode failures.
    yield* Effect.forEach(
      batches,
      (batch) => Schema.decodeUnknownEffect(V1BulkCreateSecretsInput)({ ref, body: batch }),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new LegacySecretsSetInputError({ message: `failed to set secrets: ${String(cause)}` }),
      ),
    );

    const setting = output.format === "text" ? yield* output.task("Setting secrets...") : undefined;
    yield* Effect.forEach(batches, (batch) => api.v1.bulkCreateSecrets({ ref, body: batch }), {
      discard: true,
    }).pipe(
      Effect.tapError(() => setting?.fail() ?? Effect.void),
      Effect.catch(mapSetError),
    );
    yield* setting?.clear() ?? Effect.void;

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Finished supabase secrets set.", {
        project_ref: ref,
        count: body.length,
      });
      return;
    }

    yield* output.raw("Finished supabase secrets set.\n");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
