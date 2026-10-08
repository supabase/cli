import { findCliProjectPaths, type CliConfig } from "@supabase/config/effect";
import { Effect, FileSystem, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  describeConfigSnapshotFailure,
  loadConfigSnapshotContext,
} from "../../command-internal/config-snapshot-context.ts";
import {
  resolveStorageCredentials,
  storageGatewayFetch,
} from "../../command-internal/storage-credentials.ts";
import { withStackStorageGuidance } from "../../command-internal/stack-storage.ts";
import { makeStorageGateway, type StorageGateway } from "../../command-internal/storage-gateway.ts";
import {
  GoUrlParseError,
  StorageUrlPatternError,
  parseStorageUrl,
} from "../../command-internal/storage-url.ts";
import { StorageConfigError } from "../../command-internal/storage-credentials.errors.ts";
import { missingProjectConfigMessageEffect } from "../../command-internal/workdir-project.ts";
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

interface LoadedStorageConfig {
  readonly config: CliConfig;
  readonly document: Record<string, unknown> | undefined;
  readonly appliedRemote: string | undefined;
}

/**
 * Loads the config through the snapshot (flags, env and the `[remotes.<name>]` block matching
 * `projectRef` applied), falling back to the embedded defaults when no project file exists —
 * except for a local target with an explicit `--workdir`, which raises
 * `StorageMissingProjectConfigError` instead (see that error's doc for why). A remote target
 * never hard-fails this way, since credential resolution doesn't read `config` at all.
 * `appliedRemote` is set when a `[remotes.<name>]` block matches the linked ref.
 */
export const loadStorageConfig = Effect.fn("Storage.loadConfig")(function* (
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  projectRef: string,
) {
  if (cliSettings.explicitWorkdir && projectRef === "") {
    const paths = yield* findCliProjectPaths(cliSettings.workdir, { search: false });
    if (paths === null) {
      return yield* new StorageMissingProjectConfigError({
        message: yield* missingProjectConfigMessageEffect(cliSettings),
      });
    }
  }
  const context = yield* loadConfigSnapshotContext(
    cliSettings.workdir,
    projectRef === "" ? Option.none() : Option.some(projectRef),
  ).pipe(
    Effect.catchTag(
      "CliConfigParseError",
      (cause) =>
        new StorageConfigError({
          message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
        }),
    ),
    Effect.mapError((cause) =>
      cause instanceof StorageConfigError
        ? cause
        : new StorageConfigError({ message: describeConfigSnapshotFailure(cause) }),
    ),
  );
  return {
    config: context.config,
    document: context.document,
    appliedRemote: Option.getOrUndefined(context.snapshot.appliedRemote),
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
    const credentials = yield* resolveStorageCredentials({ projectRef: opts.projectRef });
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* makeStorageGateway({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        userAgent: opts.userAgent,
      });
      return yield* body(gateway);
    });
    return yield* withStackStorageGuidance({ local: opts.projectRef === "" }, gatewayOps).pipe(
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
