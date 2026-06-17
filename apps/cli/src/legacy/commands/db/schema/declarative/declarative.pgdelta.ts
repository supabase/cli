import { Effect, FileSystem, Path } from "effect";

import {
  type LegacyEdgeRuntimeFile,
  LegacyEdgeRuntimeScript,
} from "../../../../shared/legacy-edge-runtime-script.service.ts";
import {
  LEGACY_PG_DELTA_SOURCE_SSL_ENV,
  LEGACY_PG_DELTA_TARGET_SSL_ENV,
  legacyPreparePgDeltaRef,
} from "../../../../shared/legacy-pgdelta-ssl.ts";
import {
  legacyInterpolatePgDeltaScript,
  legacyPgDeltaCatalogExportScript,
  legacyPgDeltaDeclarativeExportScript,
  legacyPgDeltaDiffScript,
} from "./declarative.deno-templates.ts";
import {
  LegacyDeclarativeEdgeRuntimeError,
  LegacyDeclarativeEmptyOutputError,
  LegacyDeclarativeParseOutputError,
} from "./declarative.errors.ts";

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

/** Result of a pg-delta diff: the SQL statements plus edge-runtime stderr. */
interface LegacyPgDeltaDiffResult {
  readonly sql: string;
  readonly stderr: string;
}

/**
 * Ambient inputs shared by every pg-delta invocation: the project id (for the
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
 * `NPM_CONFIG_REGISTRY` into the container.
 */
function legacyPgDeltaNpmRegistryOption(): {
  readonly extraFiles?: ReadonlyArray<LegacyEdgeRuntimeFile>;
  readonly extraEnv?: Readonly<Record<string, string>>;
} {
  const registry = (process.env[PG_DELTA_NPM_REGISTRY_ENV] ?? "").trim();
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

const toDeclarativeEdgeRuntimeError = (error: { readonly message: string }) =>
  new LegacyDeclarativeEdgeRuntimeError({ message: error.message });

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
  const npm = legacyPgDeltaNpmRegistryOption();
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDiffScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error diffing schema",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
    })
    .pipe(Effect.mapError(toDeclarativeEdgeRuntimeError));
  return { sql: result.stdout, stderr: result.stderr } satisfies LegacyPgDeltaDiffResult;
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
  const npm = legacyPgDeltaNpmRegistryOption();
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDeclarativeExportScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error exporting declarative schema",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
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
  const npm = legacyPgDeltaNpmRegistryOption();
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaCatalogExportScript, ctx.npmVersion),
      env,
      binds: legacyPgDeltaBinds(ctx.projectId, ctx.cwd),
      errPrefix: "error exporting pg-delta catalog",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
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
