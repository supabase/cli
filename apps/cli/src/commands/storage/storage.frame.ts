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
 * Shared plumbing for the four `storage` subcommands: resolving the project ref
 * (`--local`'s value decides local vs linked) and building the gateway client.
 */

const decodeDefaultCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

interface LoadedStorageConfig {
  readonly config: CliConfig;
  readonly document: Record<string, unknown> | undefined;
  readonly appliedRemote: string | undefined;
}

/**
 * Loads `supabase/config.toml`, falling back to the embedded defaults when it's
 * missing — except for a local target with an explicit `--workdir`, which raises
 * `StorageMissingProjectConfigError` instead (see that error's doc for why). A
 * remote target never hard-fails this way, since credential resolution doesn't
 * read `config` at all. `appliedRemote` is set when a `[remotes.<name>]` block
 * matches the linked ref.
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

/** Validates the resolved `--workdir`/`SUPABASE_WORKDIR` exists and is a directory. */
export const assertStorageWorkdir = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* validateWorkdirIsDirectory(workdir, fs).pipe(
    Effect.mapError((error) => new StorageWorkdirError({ message: error.message })),
  );
});

/**
 * Resolves Storage credentials and runs `body` against a freshly-built gateway, with
 * `FetchHttpClient.Fetch` overridden for gateway calls only (CA-trusting for a local
 * https gateway, otherwise plain `fetch`). Credential lookup runs before that
 * override scope, so it still honors `--dns-resolver https` through the Management
 * API client.
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
 * Parses a storage URL into its object path, failing with `StorageInvalidUrlError`
 * on a pattern mismatch or `StorageUrlParseError` on a URL-parse failure. Used by
 * `ls`, `mv`, and `rm`; `cp` parses `src`/`dst` directly.
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
