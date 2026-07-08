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

// Excludes arrays, matching `packages/config/src/io.ts`'s `isObject` (the
// identical "is this a table" check used when merging `[remotes.*]`). A TOML
// array for a map-typed field (e.g. `[edge_runtime] secrets = ["actual-secret"]`)
// is not a recoverable table: `Object.entries` on an array yields index keys
// ("0", "1", ...), which would otherwise fabricate spurious secret names. Go's
// mapstructure decoder never does this either — `UnmarshalExact`
// (`apps/cli-go/pkg/config/config.go:749`) never sets `WeaklyTypedInput`, so a
// slice source for a map-typed field hits `UnconvertibleTypeError` in
// `decodeMap` rather than the index-as-key `decodeMapFromSlice` path, and the
// whole field is left empty.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort recovery for a schema-decode failure (as opposed to a raw
 * TOML/JSON parse failure) on `supabase/config.toml`. Go's `viper`+
 * `mapstructure` decode (`apps/cli-go/pkg/config/config.go:749`) mutates the
 * target struct field-by-field: a type error anywhere — an unrelated
 * top-level table (`analytics.port`), a sibling field inside the same
 * `edge_runtime` table (`edge_runtime.inspector_port`), *or* a single bad
 * entry inside the `edge_runtime.secrets` map itself (`BAD = 123`) — does not
 * stop the rest of `edge_runtime.secrets` from landing in `utils.Config`.
 * `UnmarshalExact` still populates every field (and every map entry) it *can*
 * decode before aggregating errors: `mapstructure`'s map decoder
 * (`decodeMapFromMap`) iterates each key independently, appends a per-entry
 * error and `continue`s rather than aborting, then still calls `val.Set` with
 * whatever entries succeeded. Confirmed empirically against this repo's
 * actual `pkg/config`: a TOML with both a malformed `edge_runtime.inspector_port`
 * and a valid `[edge_runtime.secrets]` block still yields a populated
 * `EdgeRuntime.Secrets` (`InspectorPort` is left at its zero value), and a
 * `[edge_runtime.secrets]` block with one bad entry alongside a good one
 * still yields the good entry.
 * `Schema.decodeUnknownSync` has no such tolerance; a single bad field
 * anywhere discards the whole decode — re-decoding the *entire* `edge_runtime`
 * subtree would still fail in the sibling-field case (`inspector_port` comes
 * along for the ride), and re-decoding the whole `secrets` map atomically
 * would still fail when just one entry in that map is bad. To keep
 * `secrets set` at parity without loosening `packages/config`'s decode
 * semantics for every caller: re-slice `edge_runtime.secrets` out of the
 * pre-decode document (`cause.document` — only set when the document itself
 * parsed fine and the *schema* decode is what failed, see
 * `ProjectConfigParseError`), decode each entry independently and keep only
 * the ones that succeed (mirroring `decodeMapFromMap`'s per-key tolerance),
 * then decode the filtered map against the full schema, where every other
 * field (including the rest of `edge_runtime`) defaults cleanly. A true parse
 * failure (`cause.document` undefined) has no recoverable structure in either
 * implementation — Go's own `viper.MergeConfig` also fails the whole load
 * before `mapstructure` ever runs in that case.
 */
function recoverEdgeRuntimeConfig(cause: ProjectConfigParseError): ProjectConfig | null {
  if (cause.document === undefined) {
    return null;
  }
  const edgeRuntime = cause.document.edge_runtime;
  const secretsField = isRecord(edgeRuntime) ? edgeRuntime.secrets : undefined;
  // `redactEdgeRuntimeSecrets` (`packages/config/src/io.ts`) wraps a malformed,
  // non-object `secrets` field (e.g. a TOML array) in a single `Redacted`
  // rather than leaving it a plain record, so an uncaught error can't leak it
  // either. Unwrap before the `isRecord` check below — otherwise the
  // `Redacted` wrapper object itself (an object, just not a secrets map) gets
  // misread as a one-entry map and fabricates a bogus secret from its
  // internal fields.
  const secrets = Redacted.isRedacted(secretsField) ? Redacted.value(secretsField) : secretsField;
  const decodableSecrets = isRecord(secrets) ? filterDecodableSecrets(secrets) : undefined;
  try {
    return decodeProjectConfig({
      edge_runtime: decodableSecrets !== undefined ? { secrets: decodableSecrets } : {},
    });
  } catch {
    return null;
  }
}

/**
 * Mirrors mapstructure's per-entry map decode tolerance
 * (`decodeMapFromMap`, invoked via `v.UnmarshalExact` in
 * `apps/cli-go/pkg/config/config.go:749`): a decode error on one secret
 * value doesn't discard the whole `[edge_runtime.secrets]` map — only that
 * entry is dropped, and every other entry is still recovered.
 *
 * Each value arrives wrapped in `Redacted` (whatever its underlying type) —
 * `ProjectConfigParseError.document` wraps every `edge_runtime.secrets` entry
 * so an uncaught parse error can't leak a resolved secret, or a malformed
 * non-string entry, into a log or trace (see the field doc on `.document`).
 * Unwrap before re-decoding: `secret()`'s schema is a plain `Schema.String`,
 * not `Redacted`, and a non-string entry (e.g. an array) still fails that
 * decode and is dropped below, same as it would in Go.
 */
function filterDecodableSecrets(secrets: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(secrets)) {
    const plainValue = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    try {
      decodeProjectConfig({ edge_runtime: { secrets: { [name]: plainValue } } });
      kept[name] = plainValue;
    } catch {
      // Drop this entry only, matching mapstructure's per-key error handling.
    }
  }
  return kept;
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
    // Go swallows a malformed config.toml (or a malformed `.env`/`.env.local`
    // sibling — see the `ProjectEnvParseError` catch below) here
    // (`internal/secrets/set/set.go:20-24`: `fmt.Fprintln(utils.GetDebugLogger(), err)`)
    // and proceeds with an empty `EdgeRuntime.Secrets` — env-file and
    // positional-arg secrets still work. `secrets set` has no
    // `--linked`/`--local`/`--db-url` flag, so (unlike most commands) the root
    // `PreRun` never loads the config first either; this is the only load, and
    // it must not be fatal.
    //
    // Pass `ref` so a matching `[remotes.*]` block is merged over the base
    // config before decode, mirroring Go's `flags.LoadConfig`
    // (`internal/utils/flags/config_path.go:11-12`: `utils.Config.ProjectId =
    // ProjectRef` before `Load()`) merging the override in `loadFromFile`
    // (`pkg/config/config.go:604-609`) ahead of the tolerant decode below.
    // Without this, a schema-decode error on `--project-ref <remote-ref>`
    // would recover the *base* `[edge_runtime.secrets]` instead of the
    // explicitly selected remote's override.
    const loadedConfig = yield* loadProjectConfig(runtimeInfo.cwd, { projectRef: ref }).pipe(
      Effect.flatMap((loaded) => {
        if (loaded === null) {
          return Effect.succeed(null);
        }
        // Go prints this from inside config load, before any command output
        // (`pkg/config/config.go:605`) — unconditionally on a matching
        // `[remotes.*]` block, ahead of the (possibly failing) decode. Other
        // legacy handlers surface it the same way (e.g. `config push`); this
        // path must not silently drop it just because it maps straight down
        // to `.config` below.
        return (
          loaded.appliedRemote !== undefined
            ? output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr")
            : Effect.void
        ).pipe(Effect.as(loaded.config));
      }),
      Effect.catchTag("ProjectConfigParseError", (cause) => {
        // `smol-toml`'s `TomlError` embeds a source codeblock after a
        // blank-line separator — literal file content, which for this file's
        // `[edge_runtime.secrets]` section can include real secret values.
        // Truncating before the separator handles that case (`cause.document
        // === undefined`, a raw parse failure with no decoded document to
        // recover from — see the field doc on `ProjectConfigParseError`).
        //
        // A schema-decode error (`cause.document !== undefined`) has no such
        // separator: Effect's `ParseError` puts the rejected value inline on
        // one line (e.g. `Expected string, actual ["actual-secret"]`), which
        // the truncation above wouldn't catch. Go's pinned mapstructure
        // decode-error types (`UnconvertibleTypeError.Error()`,
        // `DecodeError.Error()`, `github.com/go-viper/mapstructure/v2
        // v2.5.0`) never include the rejected value, only type names — so a
        // fixed, content-free message here matches Go's actual behaviour
        // rather than just being defensive.
        const shortMessage =
          cause.document === undefined
            ? String(cause.cause).split("\n\n")[0]
            : "schema validation failed";
        // Go prints the override notice unconditionally as soon as a
        // `[remotes.*]` block's `project_id` matches, *before* `mapstructure`
        // decode ever runs (`pkg/config/config.go:604-609`) — so the notice is
        // still owed here even though decode subsequently failed and this
        // whole load is non-fatal. `cause.appliedRemote` carries that match
        // through the failed decode (see the field doc on
        // `ProjectConfigParseError.appliedRemote`); the success path above
        // handles the non-error case. Emitted ahead of the debug log below to
        // match Go's actual order: the print happens inside `loadFromFile`,
        // the debug log only after `flags.LoadConfig` returns the swallowed
        // error to `Run` (`internal/secrets/set/set.go:20-24`).
        return (
          cause.appliedRemote !== undefined
            ? output.raw(`Loading config override: [remotes.${cause.appliedRemote}]\n`, "stderr")
            : Effect.void
        ).pipe(
          Effect.andThen(
            debugLogger.debug(`failed to parse supabase/config.toml: ${shortMessage}`),
          ),
          Effect.as(recoverEdgeRuntimeConfig(cause)),
        );
      }),
      // `loadProjectConfig` resolves `env(VAR)` references against
      // `.env`/`.env.local` (`loadProjectEnvironment` inside
      // `loadProjectConfigFile`) *before* schema decode, so a malformed dotenv
      // line fails with this distinct tag rather than `ProjectConfigParseError`.
      // Go's `Load()` (`pkg/config/config.go:788-791`) calls `loadNestedEnv`
      // first too and returns immediately on error, before `loadFromFile` (the
      // TOML parse) ever runs — so `EdgeRuntime.Secrets` never gets populated
      // in this failure path, unlike the schema-decode-only case above. Recover
      // to `null`, not `recoverEdgeRuntimeConfig`: there is no parsed document
      // to recover a subtree from.
      Effect.catchTag("ProjectEnvParseError", (cause) =>
        debugLogger.debug(`failed to parse ${cause.path}:${cause.line}`).pipe(Effect.as(null)),
      ),
      // Two `[remotes.*]` blocks declare the same `project_id` as `ref` — Go's
      // `flags.LoadConfig` swallows *any* `Load()` error non-fatally
      // (`internal/secrets/set/set.go:22-24`), including this one, which
      // `loadFromFile` raises before `mapstructure` ever runs
      // (`pkg/config/config.go:601`). `cause.message` already matches Go's
      // string verbatim (see `DuplicateRemoteProjectIdError`'s field doc).
      Effect.catchTag("DuplicateRemoteProjectIdError", (cause) =>
        debugLogger.debug(cause.message).pipe(Effect.as(null)),
      ),
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
          // Go's `DecryptSecretHookFunc` (`pkg/config/secret.go:98`) never
          // hashes an empty value, and `ListSecrets` (`internal/secrets/set/set.go:48-52`)
          // only includes config entries with a non-empty SHA256 — so an empty
          // `[edge_runtime.secrets]` entry is silently skipped rather than sent
          // as an empty-string overwrite of a remote secret. `Redacted.isRedacted`
          // already excludes the other SHA256-empty case (a still-literal
          // `env(VAR)` reference); check for a non-empty value too so both
          // zero-hash cases match. This applies to config-sourced secrets only —
          // an explicit `--env-file`/positional `NAME=` below is sent as-is,
          // matching Go's unconditional `maps.Copy`/assignment for those sources.
          if (Redacted.isRedacted(value) && Redacted.value(value).length > 0) {
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
