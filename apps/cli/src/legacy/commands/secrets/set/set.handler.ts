import { loadProjectConfig, loadProjectEnvironment, resolveProjectSubtree } from "@supabase/config";
import { parse as parseDotenv } from "dotenv";
import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyInvalidSecretPairError,
  LegacySecretsConfigParseError,
  LegacySecretsEnvFileOpenError,
  LegacySecretsEnvFileParseError,
  LegacySecretsNoArgumentsError,
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
    // Source 1: `[edge_runtime.secrets]` from `supabase/config.toml`.
    //
    // Only resolved secret values are sent — entries whose `env(VAR)` references
    // are unresolved are skipped. This matches Go's `set.go:48-52`, which
    // filters by `len(secret.SHA256) > 0`: the SHA256 is empty exactly when
    // `DecryptSecretHookFunc` (`pkg/config/secret.go:98`) sees a still-literal
    // `env(VAR)` and returns without hashing. In the TS path, `resolveProjectSubtree`
    // wraps every resolved secret leaf in `Redacted<string>`; unresolved env()
    // literals stay as plain strings, so `Redacted.isRedacted(...)` is the
    // equivalent guard.
    const merged = new Map<string, string>();
    const loaded = yield* loadProjectConfig(runtimeInfo.cwd).pipe(
      Effect.catchTag("ProjectConfigParseError", (cause) =>
        Effect.fail(
          new LegacySecretsConfigParseError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
        ),
      ),
    );
    if (loaded !== null) {
      const projectEnv = yield* loadProjectEnvironment({
        cwd: runtimeInfo.cwd,
        baseEnv: process.env,
      });
      if (projectEnv !== null) {
        const resolved = yield* resolveProjectSubtree(
          loaded.config.edge_runtime,
          projectEnv,
          "edge_runtime",
        );
        for (const [name, value] of Object.entries(resolved.secrets ?? {})) {
          if (Redacted.isRedacted(value)) {
            merged.set(name, Redacted.value(value));
          }
        }
      }
    }

    // Source 2: --env-file entries override config.
    if (Option.isSome(flags.envFile)) {
      const rawPath = flags.envFile.value;
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(runtimeInfo.cwd, rawPath);
      const content = yield* fs.readFileString(absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new LegacySecretsEnvFileOpenError({
              message: `failed to open env file: ${String(cause)}`,
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

    // Source 3: positional NAME=VALUE pairs override env-file and config.
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

    const setting = output.format === "text" ? yield* output.task("Setting secrets...") : undefined;
    yield* api.v1.bulkCreateSecrets({ ref, body }).pipe(
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
