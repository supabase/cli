import { Effect, FileSystem, Option, Path } from "effect";

import { legacyViperEnvStringWithProjectFallback } from "../../shared/legacy/legacy-viper-env.ts";
import {
  type LegacyEdgeRuntimeFile,
  LegacyEdgeRuntimeScript,
} from "./legacy-edge-runtime-script.service.ts";
import { legacyResolveLocalProjectId, legacySanitizeProjectId } from "./legacy-docker-ids.ts";
import {
  LEGACY_PG_DELTA_SOURCE_SSL_ENV,
  LEGACY_PG_DELTA_TARGET_SSL_ENV,
  legacyPreparePgDeltaRef,
} from "./legacy-pgdelta-ssl.ts";
import {
  legacyInterpolatePgDeltaScript,
  legacyPgDeltaCatalogExportScript,
  legacyPgDeltaDeclarativeExportScript,
  legacyPgDeltaDiffScript,
} from "../commands/db/shared/legacy-pgdelta.deno-templates.ts";
import {
  LegacyDeclarativeEdgeRuntimeError,
  LegacyDeclarativeEmptyOutputError,
  LegacyDeclarativeParseOutputError,
  LegacyPgDeltaDiffParseError,
} from "../commands/db/shared/legacy-pgdelta.errors.ts";
import type { LegacyMigrationTransactionMode } from "./legacy-migration-file.ts";

const PG_DELTA_NPM_REGISTRY_ENV = "PGDELTA_NPM_REGISTRY";

/** A per-file payload from pg-delta declarative export. Mirrors Go's `DeclarativeFile`. */
interface LegacyDeclarativeFile {
  readonly path: string;
  readonly order: number;
  readonly statements: number;
  readonly sql: string;
}

/** The declarative export envelope. Mirrors Go's `DeclarativeOutput`. */
export interface LegacyDeclarativeOutput {
  readonly version: number;
  readonly mode: string;
  readonly files: ReadonlyArray<LegacyDeclarativeFile>;
}

/**
 * One execution-aware migration unit from a pg-delta diff plan. Mirrors Go's
 * `PgDeltaPlanFile` (`internal/db/diff/pgdelta.go`): a numbered SQL file whose
 * header comments record the unit number, transaction mode and boundary reason.
 */
interface LegacyPgDeltaPlanFile {
  readonly order: number;
  readonly name: string;
  readonly transactionMode: LegacyMigrationTransactionMode;
  readonly sql: string;
}

/** The pg-delta diff envelope. Mirrors Go's `PgDeltaDiffOutput`. */
interface LegacyPgDeltaDiffOutput {
  readonly version: number;
  readonly files: ReadonlyArray<
    Omit<LegacyPgDeltaPlanFile, "transactionMode"> & {
      readonly transactionMode: string;
    }
  >;
}

/**
 * Result of a pg-delta diff: the per-unit plan `files`, a `sql` flattening of
 * them (kept for `db diff` / declarative callers that consume one blob), and the
 * edge-runtime `stderr`.
 */
interface LegacyPgDeltaDiffResult {
  readonly sql: string;
  readonly files: ReadonlyArray<LegacyPgDeltaPlanFile>;
  readonly stderr: string;
}

/**
 * Ambient inputs retained for the legacy pg-delta adapter: the project id (for the
 * `supabase_edge_runtime_<id>` Deno-cache volume), the working directory (mounted
 * at `/workspace`), and the resolved pg-delta npm version (template interpolation).
 */
export interface LegacyPgDeltaContext {
  readonly projectId: string;
  readonly cwd: string;
  readonly npmVersion: string | undefined;
  /**
   * Effective `edge_runtime.deno_version` from the (remote-merged on `--linked`)
   * config, forwarded to the edge-runtime container so pg-delta runs under the
   * configured Deno image. Mirrors Go, which resolves the image from the loaded
   * config the command operates on rather than the base `config.toml`.
   */
  readonly denoVersion: number;
  /**
   * The project's parsed `supabase/.env` (`legacyReadDbToml`'s `projectEnv`), so
   * {@link legacyPgDeltaNpmRegistryOption}'s `PGDELTA_NPM_REGISTRY` read matches Go's
   * `os.Getenv`, which already observes `.env`-loaded values by this point (see that
   * function's doc comment).
   */
  readonly projectEnv: Readonly<Record<string, string>>;
}

/**
 * Resolves {@link LegacyPgDeltaContext.projectId}: Go's `Config.ProjectId` singleton
 * (`SUPABASE_PROJECT_ID` env → config.toml's `project_id` → sanitized workdir basename,
 * `pkg/config/config.go:563-570` + `Validate` :989-996), sanitized the same way
 * `UpdateDockerIds` derives `EdgeRuntimeId` from it (`internal/utils/config.go:57-76`) —
 * NOT `LegacyCliConfig.projectId` alone, which is env-only and resolves to `""` for a
 * project that relies on config.toml's `project_id` or the workdir-basename default,
 * mounting the WRONG `supabase_edge_runtime_` Deno-cache volume (review:
 * PRRT_kwDOErm0O86XAlIw). Hoisted here — the single home for every pg-delta context
 * builder (`db diff`, `db pull`, `db schema declarative generate`/`sync`) — per
 * `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
 *
 * `toml.appliedRemote !== undefined` suppresses the raw `cliProjectId` argument entirely:
 * `toml.projectId` already reflects the matched `[remotes.<ref>]` block's own `project_id`
 * at viper's override tier (`legacyReadDbToml`'s `remoteOverrideKeys.has("project_id")`
 * gate, review: PRRT_kwDOErm0O86XHGDL) — but `legacyResolveLocalProjectId` tries its FIRST
 * argument before its second, so passing the raw, ungated `cliProjectId` through would let
 * an unrelated ambient `SUPABASE_PROJECT_ID` win back over the matched remote's own id,
 * mounting the wrong Deno-cache volume for a linked pg-delta run. Mirrors the same
 * suppression `legacy-local-project-context.ts`'s own `legacyLoadLocalProjectContext`
 * already applies (review: PRRT_kwDOErm0O86XI1w8).
 */
export function legacyResolvePgDeltaProjectId(
  cliProjectId: Option.Option<string>,
  toml: { readonly projectId: Option.Option<string>; readonly appliedRemote: string | undefined },
  workdir: string,
): string {
  return legacySanitizeProjectId(
    legacyResolveLocalProjectId(
      toml.appliedRemote !== undefined ? undefined : Option.getOrUndefined(cliProjectId),
      Option.getOrUndefined(toml.projectId),
      workdir,
    ),
  );
}

/** Mirrors Go's `isPostgresURL` (`internal/db/diff/pgdelta.go:46`). */
export function legacyIsPostgresURL(ref: string): boolean {
  return ref.startsWith("postgres://") || ref.startsWith("postgresql://");
}

/**
 * Maps a host-relative catalog-file path to its in-container path (`cwd` mounted
 * at `/workspace`); Postgres URLs and empty strings pass through. Separators are
 * normalised to `/` so Windows paths resolve inside the Linux container. Mirrors
 * Go's `containerRef` (`internal/db/diff/pgdelta.go:55-60`).
 */
export function legacyPgDeltaContainerRef(ref: string): string {
  if (ref === "" || legacyIsPostgresURL(ref)) return ref;
  return `/workspace/${ref.split("\\").join("/")}`;
}

/** Mirrors Go's `utils.EdgeRuntimeId` = `GetId("edge_runtime")` = `supabase_edge_runtime_<projectId>`. */
export function legacyEdgeRuntimeId(projectId: string): string {
  return `supabase_edge_runtime_${projectId}`;
}

/**
 * The volume binds for a pg-delta run: the named Deno-cache volume (so npm
 * downloads persist across runs) and the project root mounted at `/workspace`
 * (so catalog files / `.npmrc` resolve). Mirrors the `binds` in
 * `internal/db/diff/pgdelta.go`.
 */
export function legacyPgDeltaBinds(projectId: string, cwd: string): ReadonlyArray<string> {
  return [`${legacyEdgeRuntimeId(projectId)}:/root/.cache/deno:rw`, `${cwd}:/workspace`];
}

/** Mirrors Go's `IsPgDeltaDebugEnabled` (`internal/db/diff/pgdelta_debug.go:11`). */
export function legacyIsPgDeltaDebugEnabled(): boolean {
  const value = (process.env["PGDELTA_DEBUG"] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Mirrors Go's `PgDeltaNpmRegistryOption` (`internal/utils/pgdelta_local.go:30`):
 * when `PGDELTA_NPM_REGISTRY` is set, drop a project-local `.npmrc` scoping the
 * `@supabase` registry and forward both `PGDELTA_NPM_REGISTRY` and the universal
 * `NPM_CONFIG_REGISTRY` into the container. Exported so `legacy-pgdelta.apply.ts`'s
 * declarative-apply runner (CLI-1956) can reuse the same option, matching every other
 * pg-delta edge-runtime invocation in this file.
 *
 * `PGDELTA_NPM_REGISTRY` is a bare `os.Getenv` read in Go (`pgdelta_local.go:30`), not a
 * viper-bound flag — but by the time Go reaches it, `config.Load`'s `loadNestedEnv` has
 * already run `godotenv.Load` on the project's `supabase/.env`, which calls `os.Setenv` for
 * every key not already present in the real process env (`godotenv@v1.5.1/godotenv.go:184-
 * 200`). So a project `.env`-only `PGDELTA_NPM_REGISTRY` is visible to this exact `os.Getenv`
 * call in Go. `projectEnv` reproduces that merge with the same shell-presence-wins semantics
 * (review: PRRT_kwDOErm0O86XFmjf).
 */
export function legacyPgDeltaNpmRegistryOption(projectEnv: Readonly<Record<string, string>>): {
  readonly extraFiles?: ReadonlyArray<LegacyEdgeRuntimeFile>;
  readonly extraEnv?: Readonly<Record<string, string>>;
} {
  const registry = legacyViperEnvStringWithProjectFallback(
    PG_DELTA_NPM_REGISTRY_ENV,
    projectEnv,
  ).trim();
  if (registry.length === 0) return {};
  return {
    extraFiles: [{ name: ".npmrc", content: `@supabase:registry=${registry}\n` }],
    extraEnv: { [PG_DELTA_NPM_REGISTRY_ENV]: registry, NPM_CONFIG_REGISTRY: registry },
  };
}

/** Adds the container ref + any SSL env for a SOURCE/TARGET endpoint (writes a CA bundle for Supabase-hosted remotes). */
const appendRefEnv = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  env: Record<string, string>,
  name: "SOURCE" | "TARGET",
  ref: string,
) {
  const sslRootCertEnv =
    name === "SOURCE" ? LEGACY_PG_DELTA_SOURCE_SSL_ENV : LEGACY_PG_DELTA_TARGET_SSL_ENV;
  const prepared = yield* legacyPreparePgDeltaRef(fs, path, cwd, ref, sslRootCertEnv);
  env[name] = legacyPgDeltaContainerRef(prepared.ref);
  Object.assign(env, prepared.sslEnv);
});

/** Builds the env shared by diff + declarative export (TARGET, optional SOURCE, schema, format). */
const buildDiffEnv = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  params: {
    readonly targetRef: string;
    readonly sourceRef: string;
    readonly schema: ReadonlyArray<string>;
    readonly formatOptions: string;
  },
) {
  const env: Record<string, string> = {};
  yield* appendRefEnv(fs, path, cwd, env, "TARGET", params.targetRef);
  if (params.sourceRef.length > 0)
    yield* appendRefEnv(fs, path, cwd, env, "SOURCE", params.sourceRef);
  if (params.schema.length > 0) env["INCLUDED_SCHEMAS"] = params.schema.join(",");
  if (params.formatOptions.trim().length > 0) env["FORMAT_OPTIONS"] = params.formatOptions;
  if (legacyIsPgDeltaDebugEnabled()) env["PGDELTA_DEBUG"] = "1";
  return env;
});

const toDeclarativeEdgeRuntimeError = (error: {
  readonly message: string;
  readonly docker?: "daemon" | "inspect" | "pull";
}) =>
  new LegacyDeclarativeEdgeRuntimeError({
    message: error.message,
    ...(error.docker !== undefined ? { docker: error.docker } : {}),
  });

/**
 * Diffs SOURCE → TARGET via the pg-delta diff script. Mirrors Go's
 * `DiffPgDeltaRefDetailed` (`internal/db/diff/pgdelta.go:108`). `sourceRef` may
 * be empty (diff against an empty source). Refs are either Postgres URLs
 * (`legacyToPostgresURL`) or host-relative catalog-file paths.
 */
export const legacyDiffPgDelta = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: {
    readonly targetRef: string;
    readonly sourceRef: string;
    readonly schema: ReadonlyArray<string>;
    readonly formatOptions: string;
  },
) {
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* buildDiffEnv(fs, path, ctx.cwd, params);
  const npm = legacyPgDeltaNpmRegistryOption(ctx.projectEnv);
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDiffScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error diffing schema",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
      workdir: ctx.cwd,
    })
    .pipe(Effect.mapError(toDeclarativeEdgeRuntimeError));
  // The template always prints the diff envelope on the success path, even for an
  // empty plan (`{"version":1,"files":[]}`); a truly empty stdout means no envelope
  // was produced, which we surface as "no changes" rather than a parse error.
  // Mirrors Go's `parsePgDeltaDiffOutput` (`internal/db/diff/pgdelta.go`).
  if (result.stdout.trim().length === 0) {
    return { sql: "", files: [], stderr: result.stderr } satisfies LegacyPgDeltaDiffResult;
  }
  const envelope = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as LegacyPgDeltaDiffOutput,
    catch: (cause) =>
      new LegacyPgDeltaDiffParseError({
        message: `failed to parse pg-delta diff output: ${
          cause instanceof Error ? cause.message : String(cause)
        }:\n${result.stderr}`,
      }),
  });
  const rawFiles = envelope.files ?? [];
  const files: Array<LegacyPgDeltaPlanFile> = [];
  for (const file of rawFiles) {
    const transactionMode = file.transactionMode;
    if (transactionMode !== "transactional" && transactionMode !== "none") {
      return yield* Effect.fail(
        new LegacyPgDeltaDiffParseError({
          message: `unknown pg-delta transaction mode ${JSON.stringify(transactionMode)}`,
        }),
      );
    }
    files.push({ ...file, transactionMode });
  }
  // Flatten to one blob for callers that need it; unit header comments keep the
  // transaction boundaries visible (mirrors Go's `joinPgDeltaFiles`).
  const sql = files.map((file) => file.sql).join("\n\n");
  return { sql, files, stderr: result.stderr } satisfies LegacyPgDeltaDiffResult;
});

/**
 * Exports TARGET as declarative file payloads. Mirrors Go's
 * `DeclarativeExportPgDeltaRef` (`internal/db/diff/pgdelta.go:156`): empty output
 * is an error, and the JSON envelope is parsed into `LegacyDeclarativeOutput`.
 */
export const legacyDeclarativeExportPgDelta = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: {
    readonly targetRef: string;
    readonly sourceRef: string;
    readonly schema: ReadonlyArray<string>;
    readonly formatOptions: string;
  },
) {
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* buildDiffEnv(fs, path, ctx.cwd, params);
  const npm = legacyPgDeltaNpmRegistryOption(ctx.projectEnv);
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDeclarativeExportScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error exporting declarative schema",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
      workdir: ctx.cwd,
    })
    .pipe(Effect.mapError(toDeclarativeEdgeRuntimeError));

  if (result.stdout.length === 0) {
    return yield* Effect.fail(
      new LegacyDeclarativeEmptyOutputError({
        message: `error exporting declarative schema: edge-runtime script produced no output:\n${result.stderr}`,
      }),
    );
  }

  return yield* Effect.try({
    try: () => JSON.parse(result.stdout) as LegacyDeclarativeOutput,
    catch: (cause) =>
      new LegacyDeclarativeParseOutputError({
        message: `failed to parse declarative export output: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });
});

/**
 * Serializes TARGET into a pg-delta catalog snapshot (JSON) for caching. Mirrors
 * Go's `ExportCatalogPgDelta` (`internal/db/diff/pgdelta.go:199`): `role`
 * optionally steps down the connection; empty output is an error; the snapshot is
 * trimmed.
 */
export const legacyExportCatalogPgDelta = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: { readonly targetRef: string; readonly role: string },
) {
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env: Record<string, string> = {};
  yield* appendRefEnv(fs, path, ctx.cwd, env, "TARGET", params.targetRef);
  if (params.role.length > 0) env["ROLE"] = params.role;
  const npm = legacyPgDeltaNpmRegistryOption(ctx.projectEnv);
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaCatalogExportScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error exporting pg-delta catalog",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
      workdir: ctx.cwd,
    })
    .pipe(Effect.mapError(toDeclarativeEdgeRuntimeError));

  const snapshot = result.stdout.trim();
  if (snapshot.length === 0) {
    return yield* Effect.fail(
      new LegacyDeclarativeEmptyOutputError({
        message: `error exporting pg-delta catalog: edge-runtime script produced no output:\n${result.stderr}`,
      }),
    );
  }
  return snapshot;
});
