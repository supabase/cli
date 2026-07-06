import {
  loadProjectConfig,
  loadProjectEnvironment,
  ProjectConfigSchema,
  resolveProjectSubtree,
  type ProjectConfig,
  type ProjectConfigParseError,
} from "@supabase/config";
import { parse as parseDotenv } from "dotenv";
import { Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
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

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Best-effort recovery for a schema-decode failure (as opposed to a raw
 * TOML/JSON parse failure) on `supabase/config.toml`. Go's `viper`+
 * `mapstructure` decode (`apps/cli-go/pkg/config/config.go:749`) mutates the
 * target struct field-by-field: a type error anywhere — an unrelated
 * top-level table (`analytics.port`) *or* a sibling field inside the same
 * `edge_runtime` table (`edge_runtime.inspector_port`) — does not stop
 * `edge_runtime.secrets` from landing in `utils.Config`, because
 * `UnmarshalExact` still populates every field it *can* decode before
 * aggregating errors. Confirmed empirically against this repo's actual
 * `pkg/config`: a TOML with both a malformed `edge_runtime.inspector_port`
 * and a valid `[edge_runtime.secrets]` block still yields a populated
 * `EdgeRuntime.Secrets` (`InspectorPort` is left at its zero value).
 * `Schema.decodeUnknownSync` has no such tolerance; a single bad field
 * anywhere discards the whole decode — and re-decoding the *entire*
 * `edge_runtime` subtree (as opposed to just `secrets`) would still fail in
 * the sibling-field case, since `inspector_port` comes along for the ride. To
 * keep `secrets set` at parity without loosening `packages/config`'s decode
 * semantics for every caller, re-slice just `edge_runtime.secrets` out of the
 * pre-decode document (`cause.document` — only set when the document itself
 * parsed fine and the *schema* decode is what failed, see
 * `ProjectConfigParseError`) and re-decode it alone against the full schema,
 * where every other field (including the rest of `edge_runtime`) defaults
 * cleanly. A true parse failure (`cause.document` undefined) has no
 * recoverable structure in either implementation — Go's own
 * `viper.MergeConfig` also fails the whole load before `mapstructure` ever
 * runs in that case.
 */
function recoverEdgeRuntimeConfig(cause: ProjectConfigParseError): ProjectConfig | null {
  if (cause.document === undefined) {
    return null;
  }
  const edgeRuntime = cause.document.edge_runtime;
  const secrets = isRecord(edgeRuntime) ? edgeRuntime.secrets : undefined;
  try {
    return decodeProjectConfig({
      edge_runtime: isRecord(secrets) ? { secrets } : {},
    });
  } catch {
    return null;
  }
}

export const legacySecretsSet = Effect.fn("legacy.secrets.set")(function* (
  flags: LegacySecretsSetFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const debugLogger = yield* LegacyDebugLogger;
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
    // Go swallows a malformed config.toml here (`internal/secrets/set/set.go:20-24`:
    // `fmt.Fprintln(utils.GetDebugLogger(), err)`) and proceeds with an empty
    // `EdgeRuntime.Secrets` — env-file and positional-arg secrets still work.
    // `secrets set` has no `--linked`/`--local`/`--db-url` flag, so (unlike most
    // commands) the root `PreRun` never loads the config first either; this is
    // the only load, and it must not be fatal.
    const loadedConfig = yield* loadProjectConfig(runtimeInfo.cwd).pipe(
      Effect.map((loaded) => loaded?.config ?? null),
      Effect.catchTag("ProjectConfigParseError", (cause) => {
        // `smol-toml`'s `TomlError` (and some schema-decode errors) embed a
        // source codeblock after a blank-line separator — literal file content,
        // which for this file's `[edge_runtime.secrets]` section can include
        // real secret values. Go's equivalent log line (`DecodeError.Error()`)
        // is a short, content-free message; only its unused `.String()` method
        // includes a snippet, and Go's `set.go:20-24` never calls it. Truncate
        // before the separator so a syntax error next to a secret line can't
        // echo that secret to `--debug` output.
        const shortMessage = String(cause.cause).split("\n\n")[0];
        return debugLogger
          .debug(`failed to parse supabase/config.toml: ${shortMessage}`)
          .pipe(Effect.as(recoverEdgeRuntimeConfig(cause)));
      }),
    );
    if (loadedConfig !== null) {
      const projectEnv = yield* loadProjectEnvironment({
        cwd: runtimeInfo.cwd,
        baseEnv: process.env,
      });
      if (projectEnv !== null) {
        const resolved = yield* resolveProjectSubtree(
          loadedConfig.edge_runtime,
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
