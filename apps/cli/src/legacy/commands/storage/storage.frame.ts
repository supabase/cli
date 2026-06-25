import {
  loadProjectConfig,
  type LoadProjectConfigOptions,
  ProjectConfigSchema,
  type ProjectConfig,
} from "@supabase/config";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  legacyResolveStorageCredentials,
  legacyStorageGatewayFetch,
} from "../../shared/legacy-storage-credentials.ts";
import {
  legacyMakeStorageGateway,
  type LegacyStorageGateway,
} from "../../shared/legacy-storage-gateway.ts";
import {
  LegacyGoUrlParseError,
  LegacyStorageUrlPatternError,
  legacyParseStorageUrl,
} from "../../shared/legacy-storage-url.ts";
import { LegacyStorageConfigError } from "../../shared/legacy-storage-credentials.errors.ts";
import { LegacyStorageInvalidUrlError, LegacyStorageUrlParseError } from "./storage.errors.ts";

/**
 * Shared plumbing for the four `storage` subcommands. Each handler resolves the
 * project ref (the value of `--local` decides local vs linked, mirroring Go's
 * `storage.go:21-32`), then uses these helpers for the parts Go shares via
 * `utils.Config` + `client.NewStorageAPI`.
 */

const decodeDefaultProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

interface LegacyLoadedStorageConfig {
  readonly config: ProjectConfig;
  readonly document: Record<string, unknown> | undefined;
  readonly appliedRemote: string | undefined;
}

/**
 * Load `supabase/config.toml`, mirroring Go's always-loaded `utils.Config`
 * (DQ-4): a parse failure aborts (`LegacyStorageConfigError`); a missing file
 * falls back to the embedded defaults (Go's package-global config, initialized
 * to defaults, with `config.Load` a no-op on a missing file). When a
 * `[remotes.<name>]` block matches the linked ref, `appliedRemote` carries its
 * name so the caller can print Go's `Loading config override:` line.
 */
export const legacyLoadStorageConfig = Effect.fnUntraced(function* (
  workdir: string,
  projectRef: string,
) {
  const loadOptions: LoadProjectConfigOptions | undefined =
    projectRef !== "" ? { projectRef } : undefined;
  const loaded = yield* loadProjectConfig(workdir, loadOptions).pipe(
    Effect.catchTag(
      "ProjectConfigParseError",
      (cause) =>
        new LegacyStorageConfigError({
          message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
        }),
    ),
  );
  if (loaded === null) {
    return {
      config: decodeDefaultProjectConfig({}),
      document: undefined,
      appliedRemote: undefined,
    } satisfies LegacyLoadedStorageConfig;
  }
  return {
    config: loaded.config,
    document: loaded.document,
    appliedRemote: loaded.appliedRemote,
  } satisfies LegacyLoadedStorageConfig;
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
 * `legacyMakeStorageGateway` only constructs the client object (no network), so
 * building it inside the override scope is fine; the override is read per request
 * from the fiber context when a gateway call executes.
 */
export const legacyConnectStorageGateway = <E, R>(
  opts: { readonly projectRef: string; readonly config: ProjectConfig; readonly userAgent: string },
  body: (gateway: LegacyStorageGateway) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const credentials = yield* legacyResolveStorageCredentials({
      projectRef: opts.projectRef,
      config: opts.config,
    });
    const gatewayOps = Effect.gen(function* () {
      const gateway = yield* legacyMakeStorageGateway({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        userAgent: opts.userAgent,
      });
      return yield* body(gateway);
    });
    return yield* gatewayOps.pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        legacyStorageGatewayFetch(credentials.localKongCa),
      ),
    );
  });

/**
 * Go `client.ParseStorageURL` as an Effect: returns the object path or fails
 * with the tagged `LegacyStorageInvalidUrlError` (pattern mismatch) /
 * `LegacyStorageUrlParseError` (url-parse failure, wrapped like Go's
 * `failed to parse storage url: %w`). Used by `ls`, `mv`, and `rm`; `cp` parses
 * `src`/`dst` with `legacyGoUrlParse` directly (it branches on the scheme and
 * wraps as `failed to parse src url` / `failed to parse dst url`).
 */
export const legacyParseStorageUrlEffect = (objectUrl: string) =>
  Effect.try({
    try: () => legacyParseStorageUrl(objectUrl),
    catch: (cause) => {
      if (cause instanceof LegacyStorageUrlPatternError) {
        return new LegacyStorageInvalidUrlError();
      }
      const message = cause instanceof LegacyGoUrlParseError ? cause.message : String(cause);
      return new LegacyStorageUrlParseError({ message: `failed to parse storage url: ${message}` });
    },
  });
