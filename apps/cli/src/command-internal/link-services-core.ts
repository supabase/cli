import type { ApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { CommandSettings } from "../config/command-settings.service.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { tempPaths } from "./temp-paths.ts";
import {
  fetchGotrueVersion,
  fetchPostgrestVersion,
  fetchStorageVersion,
} from "./tenant-versions.ts";

export interface LinkServicesInput {
  readonly ref: string;
  /**
   * Tenant API key used for the service version probes. `link` passes the
   * service-role key; `bootstrap` passes the anon key (mirroring Go's
   * `link.LinkServices(ctx, ref, tenant.NewApiKey(keys).Anon, …)`).
   */
  readonly serviceKey: string;
  readonly skipPooler: boolean;
  /**
   * Absolute project directory whose `supabase/.temp/*` files receive the linked
   * service metadata. Passed explicitly (never read from `CommandSettings.workdir`)
   * because `bootstrap` links a freshly created project directory that differs
   * from the cwd-walked config workdir.
   */
  readonly workdir: string;
}

type WriteTempFile = (filePath: string, content: string) => Effect.Effect<void, PlatformError>;

/**
 * Ports `link.LinkServices`: the
 * best-effort portion of linking that writes `supabase/.temp/{storage-migration,
 * pooler-url,rest-version,gotrue-version,storage-version}`. Every probe is
 * best-effort — a single unreachable service never fails the caller. This core
 * does NOT write `project-ref`, the linked-project cache, or fire
 * `cli_project_linked`; `link.Run` (the standalone command) owns those, and
 * `bootstrap` deliberately skips them by calling `LinkServices` directly.
 */
export const linkServicesCore = Effect.fnUntraced(function* (input: LinkServicesInput) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = tempPaths(path, input.workdir);

  const writeTempFile: WriteTempFile = (filePath, content) =>
    fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(Effect.andThen(() => fs.writeFileString(filePath, content)));

  yield* linkStorageMigration(api, input.ref, paths.storageMigration, writeTempFile);
  yield* linkPooler({
    api,
    ref: input.ref,
    skipPooler: input.skipPooler,
    fs,
    poolerUrlPath: paths.poolerUrl,
    writeTempFile,
  });

  const tenantOpts = {
    ref: input.ref,
    projectHost: cliSettings.projectHost,
    serviceKey: input.serviceKey,
    userAgent: cliSettings.userAgent,
  };
  yield* fetchPostgrestVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? writeTempFile(paths.restVersion, v.value) : Effect.void,
    ),
    Effect.ignore,
  );
  yield* fetchGotrueVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? writeTempFile(paths.gotrueVersion, v.value) : Effect.void,
    ),
    Effect.ignore,
  );
  yield* fetchStorageVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? writeTempFile(paths.storageVersion, v.value) : Effect.void,
    ),
    Effect.ignore,
  );
});

const linkStorageMigration = (
  api: ApiClient,
  ref: string,
  storageMigrationPath: string,
  writeTempFile: WriteTempFile,
) =>
  api.v1.getStorageConfig({ ref }).pipe(
    Effect.flatMap((config) => writeTempFile(storageMigrationPath, config.migrationVersion)),
    Effect.ignore,
  );

const linkPooler = (opts: {
  api: ApiClient;
  ref: string;
  skipPooler: boolean;
  fs: FileSystem.FileSystem;
  poolerUrlPath: string;
  writeTempFile: WriteTempFile;
}) =>
  Effect.gen(function* () {
    if (opts.skipPooler) {
      // Use direct connection: drop any cached pooler URL.
      yield* opts.fs.remove(opts.poolerUrlPath, { recursive: true }).pipe(Effect.ignore);
      return;
    }
    const configs = yield* opts.api.v1.getPoolerConfig({ ref: opts.ref });
    const primary = configs.find((c) => c.database_type === "PRIMARY");
    if (primary === undefined) return;
    // Strip the [YOUR-PASSWORD] placeholder; force session mode 5432 unless the
    // pooler already reports session mode.
    let connectionString = primary.connection_string.replaceAll(":[YOUR-PASSWORD]", "");
    if (primary.pool_mode !== "session") {
      connectionString = connectionString.replaceAll(":6543/", ":5432/");
    }
    yield* opts.writeTempFile(opts.poolerUrlPath, connectionString);
  }).pipe(Effect.ignore);
