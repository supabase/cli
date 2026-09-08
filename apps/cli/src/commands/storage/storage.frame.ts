import { CliConfigSchema, type CliConfig } from "@supabase/config/effect";
import { loadCliConfig, type InternalLoadCliConfigOptions } from "@supabase/config/internal";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  resolveStorageCredentials,
  storageGatewayFetch,
} from "../../command-internal/storage-credentials.ts";
import { makeStorageGateway, type StorageGateway } from "../../command-internal/storage-gateway.ts";
import {
  GoUrlParseError,
  StorageUrlPatternError,
  parseStorageUrl,
} from "../../command-internal/storage-url.ts";
import { StorageConfigError } from "../../command-internal/storage-credentials.errors.ts";
import { missingProjectConfigMessageEffect } from "../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import {
  StorageInvalidUrlError,
  StorageMissingProjectConfigError,
  StorageUrlParseError,
  StorageWorkdirError,
} from "./storage.errors.ts";

/**
 * Shared plumbing for the four `storage` subcommands. Each handler resolves the
 * project ref (the value of `--local` decides local vs linked, mirroring Go's
 * `storage.go:21-32`), then uses these helpers for the parts Go shares via
 * `utils.Config` + `client.NewStorageAPI`.
 */

const decodeDefaultCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

interface LoadedStorageConfig {
  readonly config: CliConfig;
  readonly document: Record<string, unknown> | undefined;
  readonly appliedRemote: string | undefined;
}

/**
 * Load `supabase/config.toml`: a parse failure aborts
 * (`StorageConfigError`); a missing file falls back to the embedded
 * defaults — EXCEPT for a LOCAL target (`projectRef === ""`) with an
 * explicitly-set `--workdir`/`SUPABASE_WORKDIR`, where it hard-fails instead
 * (`StorageMissingProjectConfigError`): the embedded default `api.port`
 * could otherwise retarget a local `storage rm -r` (or any other operation)
 * at a different, possibly running, local stack. A REMOTE target
 * (`--project-ref`/`--linked`) never hard-fails on this, explicit workdir or
 * not: `resolveStorageCredentials` doesn't read `config` at all on that
 * path (Management API credentials only), so a config-less workdir poses no
 * such risk there — it would only cost the (cosmetic) `[remotes.*]` override
 * line. A DEFAULTED workdir keeps the established tolerant fallback either
 * way. When a `[remotes.<name>]` block matches the linked ref, `appliedRemote`
 * carries its name so the caller can print the `Loading config override:`
 * line.
 */
export const loadStorageConfig = Effect.fnUntraced(function* (
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  projectRef: string,
) {
  const loadOptions: InternalLoadCliConfigOptions =
    projectRef !== ""
      ? { projectRef, goViperCompat: true, search: shouldSearchAncestors(cliSettings) }
      : { goViperCompat: true, search: shouldSearchAncestors(cliSettings) };
  const loaded = yield* loadCliConfig(cliSettings.workdir, loadOptions).pipe(
    Effect.catchTag(
      "CliConfigParseError",
      (cause) =>
        new StorageConfigError({
          message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
        }),
    ),
  );
  if (loaded === null) {
    if (cliSettings.explicitWorkdir && projectRef === "") {
      return yield* new StorageMissingProjectConfigError({
        message: yield* missingProjectConfigMessageEffect(cliSettings),
      });
    }
    return {
      config: decodeDefaultCliConfig({}),
      document: undefined,
      appliedRemote: undefined,
    } satisfies LoadedStorageConfig;
  }
  return {
    config: loaded.config,
    document: loaded.document,
    appliedRemote: loaded.appliedRemote,
  } satisfies LoadedStorageConfig;
});

/**
 * Validates the resolved `--workdir`/`SUPABASE_WORKDIR` exists and is a
 * directory (`validateWorkdirIsDirectory`), mapping into the shared
 * `StorageWorkdirError` — hoisted here (rather than duplicated across
 * `ls`/`mv`/`rm`/`cp`) since `ls`/`mv` don't otherwise need `FileSystem` in
 * scope.
 */
export const assertStorageWorkdir = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* validateWorkdirIsDirectory(workdir, fs).pipe(
    Effect.mapError((error) => new StorageWorkdirError({ message: error.message })),
  );
});

/**
 * Resolve Storage credentials and run `body` against a freshly-built gateway,
 * with the `FetchHttpClient.Fetch` override applied to the gateway calls only
 * (CA-trusting for a local https gateway, plain `globalThis.fetch` otherwise).
 *
 * The credential lookup (the `--linked` api-keys call) runs BEFORE the override
 * scope, so it still honors `--dns-resolver https` through the Management API
 * client — mirroring Go, where Storage uses `status.NewKongClient` /
 * `http.DefaultClient` while `tenant.GetApiKeys` uses the DoH-wrapped client.
 *
 * `makeStorageGateway` only constructs the client object (no network), so
 * building it inside the override scope is fine; the override is read per request
 * from the fiber context when a gateway call executes.
 */
export const connectStorageGateway = <E, R>(
  opts: { readonly projectRef: string; readonly config: CliConfig; readonly userAgent: string },
  body: (gateway: StorageGateway) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const credentials = yield* resolveStorageCredentials({
      projectRef: opts.projectRef,
      config: opts.config,
    });
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        userAgent: opts.userAgent,
      });
      return yield* body(gateway);
    });
    return yield* gatewayOps.pipe(
      Effect.provideService(FetchHttpClient.Fetch, storageGatewayFetch(credentials.localKongCa)),
    );
  });

/**
 * Go `client.ParseStorageURL` as an Effect: returns the object path or fails
 * with the tagged `StorageInvalidUrlError` (pattern mismatch) /
 * `StorageUrlParseError` (url-parse failure, wrapped like Go's
 * `failed to parse storage url: %w`). Used by `ls`, `mv`, and `rm`; `cp` parses
 * `src`/`dst` with `goUrlParse` directly (it branches on the scheme and
 * wraps as `failed to parse src url` / `failed to parse dst url`).
 */
export const parseStorageUrlEffect = (objectUrl: string) =>
  Effect.try({
    try: () => parseStorageUrl(objectUrl),
    catch: (cause) => {
      if (cause instanceof StorageUrlPatternError) {
        return new StorageInvalidUrlError();
      }
      const message = cause instanceof GoUrlParseError ? cause.message : String(cause);
      return new StorageUrlParseError({ message: `failed to parse storage url: ${message}` });
    },
  });
