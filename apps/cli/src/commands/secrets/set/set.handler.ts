import { CliConfigSchema, type CliConfig } from "@supabase/config/effect";
import {
  mergeParsedCliConfig,
  parseCliConfigDocumentFile,
  resolveCliConfigSubtree,
} from "@supabase/config/internal";
import { V1BulkCreateSecretsInput } from "@supabase/api/effect";
import { parse as parseDotenv } from "dotenv";
import { Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { cliRemoteProjectIdEnvName } from "../../../config/cli-config-keys.ts";
import { selectCliConfigRemote } from "../../../config/cli-config-remote.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import {
  collectEnvReferences,
  loadConfigEnvLookup,
} from "../../../command-internal/config-env-lookup.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  InvalidSecretPairError,
  SecretsEnvFileOpenError,
  SecretsEnvFileParseError,
  SecretsNoArgumentsError,
  SecretsSetInputError,
  SecretsSetNetworkError,
  SecretsSetUnexpectedStatusError,
} from "../secrets.errors.ts";
import type { SecretsSetFlags } from "./set.command.ts";

const mapSetError = mapHttpError({
  networkError: SecretsSetNetworkError,
  statusError: SecretsSetUnexpectedStatusError,
  networkMessage: (cause) => `failed to set secrets: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error setting project secrets: ${body}`,
});

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

// Excludes arrays: `Object.entries` on an array yields index keys ("0", "1", ...), which would
// otherwise fabricate spurious secret names from a misconfigured `secrets = [...]` field.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort recovery of `[edge_runtime.secrets]` from a document that failed schema decode
 * (not a raw parse failure). Matches the CLI's established per-field decode tolerance: an
 * unrelated bad field, or a single bad entry inside `secrets` itself, must not discard every
 * otherwise-valid secret. `Schema.decodeUnknownSync` has no such tolerance, so this re-slices
 * `edge_runtime.secrets` out of the pre-decode document and decodes each entry independently.
 */
function recoverEdgeRuntimeConfig(cause: { readonly document?: unknown }): CliConfig | null {
  if (!isRecord(cause.document)) {
    return null;
  }
  const edgeRuntime = cause.document.edge_runtime;
  const secretsField = isRecord(edgeRuntime) ? edgeRuntime.secrets : undefined;
  // A malformed, non-object `secrets` field arrives wrapped in `Redacted`; unwrap before the
  // `isRecord` check below, or the wrapper object itself gets misread as a one-entry map and
  // fabricates a bogus secret from its internal fields.
  const secrets = Redacted.isRedacted(secretsField) ? Redacted.value(secretsField) : secretsField;
  const decodableSecrets = isRecord(secrets) ? filterDecodableSecrets(secrets) : undefined;
  try {
    return decodeCliConfig({
      edge_runtime: decodableSecrets !== undefined ? { secrets: decodableSecrets } : {},
    });
  } catch {
    return null;
  }
}

/**
 * Decodes each `edge_runtime.secrets` entry independently and keeps only the ones that
 * succeed, so one bad value doesn't discard the whole map. Each value arrives wrapped in
 * `Redacted` (protecting it from leaking into a log if decode fails); unwrap before re-decoding
 * since `secret()`'s schema is a plain `Schema.String`, not `Redacted`.
 */
function filterDecodableSecrets(secrets: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(secrets)) {
    const plainValue = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    try {
      decodeCliConfig({ edge_runtime: { secrets: { [name]: plainValue } } });
      kept[name] = plainValue;
    } catch {
      // Drop this entry only.
    }
  }
  return kept;
}

/** The merged document with the remote for `ref` applied, read without decoding any value. */
const recoverMergedDocument = Effect.fnUntraced(
  function* (workdir: string, ref: string) {
    const parsed = yield* parseCliConfigDocumentFile(workdir, { search: false });
    if (parsed === null) return undefined;
    const remotes = parsed.rawDocument?.["remotes"];
    const { lookup } = yield* loadConfigEnvLookup(
      workdir,
      [remotes],
      isRecord(remotes) ? Object.keys(remotes).map(cliRemoteProjectIdEnvName) : [],
    ).pipe(Effect.orDie);
    const merged = yield* mergeParsedCliConfig(parsed, {
      selectRemote: (candidates) => selectCliConfigRemote(candidates, Option.some(ref), lookup),
    });
    return { document: merged.document, appliedRemote: merged.appliedRemote };
  },
  Effect.orElseSucceed(() => undefined),
);

export const secretsSet = Effect.fn("secrets.set")(function* (flags: SecretsSetFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const debugLogger = yield* DebugLogger;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // Source 1: `[edge_runtime.secrets]` from `supabase/config.toml`. Only resolved values are
    // sent: `resolveCliConfigSubtree` wraps every resolved secret leaf in `Redacted<string>`,
    // while unresolved `env(VAR)` references stay plain strings, so `Redacted.isRedacted`
    // distinguishes them.
    const merged = new Map<string, string>();
    // A malformed config.toml (or sibling .env/.env.local) is swallowed here (logged, not
    // fatal) and proceeds with empty config-sourced secrets — env-file and positional-arg
    // secrets still work.
    //
    // Passing `ref` merges a matching `[remotes.*]` block over the base config before decode,
    // so a schema-decode error on a remote target recovers that remote's override, not the base
    // document.
    const reportRemote = (appliedRemote: string | undefined) =>
      appliedRemote === undefined
        ? Effect.void
        : output.raw(`Loading config override: [remotes.${appliedRemote}]\n`, "stderr");
    const edgeRuntime = yield* configValues
      .load({ workdir: cliSettings.workdir, projectRef: Option.some(ref) })
      .pipe(
        Effect.flatMap((snapshot) =>
          // Printed unconditionally as soon as a matching `[remotes.*]` block is found, ahead of
          // the (possibly failing) decode — other handlers surface this the same way, so this
          // path must not silently drop it.
          reportRemote(Option.getOrUndefined(snapshot.appliedRemote)).pipe(
            Effect.as(snapshot.materialized.config.edge_runtime),
          ),
        ),
        Effect.catchTags({
          CliConfigParseError: (cause) => {
            // `smol-toml` embeds a source codeblock (which can include real secret values) after a
            // blank-line separator on a raw parse failure; truncate before it. A schema-decode
            // error puts the rejected value inline instead, with no such separator, so use a fixed,
            // content-free message there.
            const shortMessage =
              cause.document === undefined
                ? String(cause.cause).split("\n\n")[0]
                : "schema validation failed";
            // Printed here too since a matching `[remotes.*]` block is found before decode runs,
            // even though decode then failed. Emitted ahead of the debug log below to preserve
            // that order.
            return reportRemote(cause.appliedRemote).pipe(
              Effect.andThen(
                debugLogger.debug(`failed to parse supabase/config.toml: ${shortMessage}`),
              ),
              Effect.as(recoverEdgeRuntimeConfig(cause)?.edge_runtime),
            );
          },
          // An invalid value in an unrelated key fails the snapshot before decode; recover from the
          // merged document the same way a schema-decode error does.
          CliConfigValueError: () =>
            recoverMergedDocument(cliSettings.workdir, ref).pipe(
              Effect.flatMap((recovered) =>
                reportRemote(recovered?.appliedRemote).pipe(
                  Effect.andThen(
                    debugLogger.debug(
                      "failed to parse supabase/config.toml: schema validation failed",
                    ),
                  ),
                  Effect.as(
                    recovered === undefined
                      ? undefined
                      : recoverEdgeRuntimeConfig(recovered)?.edge_runtime,
                  ),
                ),
              ),
            ),
          // A malformed dotenv file or `[remotes.*]` block (duplicate or malformed `project_id`)
          // has no parsed document to recover a subtree from — recover to `undefined`, not
          // `recoverEdgeRuntimeConfig`.
          CliConfigLoadError: (cause) =>
            debugLogger.debug(cause.message).pipe(Effect.as(undefined)),
          DuplicateRemoteProjectIdError: (cause) =>
            debugLogger.debug(cause.message).pipe(Effect.as(undefined)),
          InvalidRemoteProjectIdError: (cause) =>
            debugLogger.debug(cause.message).pipe(Effect.as(undefined)),
          ProjectRefReadError: (cause) =>
            debugLogger.debug(cause.message).pipe(Effect.as(undefined)),
        }),
      );
    if (edgeRuntime !== undefined) {
      const { lookup } = yield* loadConfigEnvLookup(cliSettings.workdir, [edgeRuntime]).pipe(
        Effect.orDie,
      );
      const names = new Set<string>();
      collectEnvReferences(edgeRuntime, names);
      const values: Record<string, string> = {};
      for (const name of names) {
        const value = lookup(name);
        if (value !== undefined) values[name] = value;
      }
      const resolved = yield* resolveCliConfigSubtree(edgeRuntime, { values }, "edge_runtime", {
        goViperCompat: true,
      });
      const secrets = isRecord(resolved) ? resolved["secrets"] : undefined;
      for (const [name, value] of Object.entries(isRecord(secrets) ? secrets : {})) {
        // An empty `[edge_runtime.secrets]` value is skipped rather than sent as an
        // empty-string overwrite of a remote secret. This applies to config-sourced secrets
        // only — an explicit `--env-file`/positional `NAME=` below is sent as-is regardless
        // of value.
        if (Redacted.isRedacted(value) && Redacted.value(value).length > 0) {
          merged.set(name, Redacted.value(value));
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
            new SecretsEnvFileOpenError({
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
      const parsed = yield* Effect.try({
        try: () => parseDotenv(content),
        catch: (cause) =>
          new SecretsEnvFileParseError({
            message: `failed to parse env file: ${String(cause)}`,
          }),
      });
      for (const [name, value] of Object.entries(parsed)) {
        merged.set(name, value);
      }
    }

    // Source 3: positional NAME=VALUE pairs override env-file and config.
    for (const pair of flags.secrets) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        return yield* new InvalidSecretPairError({
          pair,
          message: `Invalid secret pair: ${pair}. Must be NAME=VALUE.`,
        });
      }
      merged.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    // The API also rejects `SUPABASE_`-prefixed names server-side, but filtering client-side
    // first avoids surfacing a raw SchemaError instead of this warning.
    const body: Array<{ name: string; value: string }> = [];
    for (const [name, value] of merged) {
      if (name.startsWith("SUPABASE_")) {
        yield* output.raw(`Env name cannot start with SUPABASE_, skipping: ${name}\n`, "stderr");
        continue;
      }
      body.push({ name, value });
    }

    if (body.length === 0) {
      return yield* new SecretsNoArgumentsError({
        message: "No arguments found. Use --env-file to read from a .env file.",
      });
    }

    // The Management API caps a single bulk-create request at 100 secrets
    // (`V1BulkCreateSecretsInput`'s `isMaxLength(100)` check); split into batches so large env
    // files still upload instead of being rejected wholesale.
    const SECRETS_PER_REQUEST = 100;
    const batches: Array<typeof body> = [];
    for (let i = 0; i < body.length; i += SECRETS_PER_REQUEST) {
      batches.push(body.slice(i, i + SECRETS_PER_REQUEST));
    }

    yield* Effect.annotateCurrentSpan({
      "secret.count": body.length,
      "secret.batch_count": batches.length,
    });

    // Validated up front so a schema-invalid entry in a later batch can't leave the project
    // partially updated after earlier batches already uploaded.
    yield* Effect.forEach(
      batches,
      (batch) => Schema.decodeEffect(V1BulkCreateSecretsInput)({ ref, body: batch }),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) => new SecretsSetInputError({ message: `failed to set secrets: ${String(cause)}` }),
      ),
    );

    const setting = output.format === "text" ? yield* output.task("Setting secrets...") : undefined;
    yield* Effect.forEach(batches, (batch) => api.v1.bulkCreateSecrets({ ref, body: batch }), {
      discard: true,
    }).pipe(
      Effect.tapError(() => setting?.fail() ?? Effect.void),
      Effect.catch(mapSetError),
    );
    yield* setting?.clear ?? Effect.void;

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
