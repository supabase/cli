import { type FileSystem, Effect, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import {
  type LegacyDebugBundle,
  legacyDebugBundleMessage,
  legacySaveDebugBundle,
} from "../shared/legacy-debug-bundle.ts";
import { legacyPgDeltaTempPath } from "../shared/legacy-pgdelta.cache.ts";
import { type LegacyPgDeltaContext, legacyExportCatalogPgDelta } from "../shared/legacy-pgdelta.ts";

// Go's `errInSync` (`internal/db/pull/pull.go:33`).
const ERR_IN_SYNC = "No schema changes found";

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Port of Go's `redactPostgresURL` (`internal/db/pull/pgdelta_pull_debug.go`):
 * replace the password (keeping the username) with `xxxxx`; an empty username
 * becomes `redacted`; a URL with no userinfo is unchanged; a parse failure
 * returns the literal `<invalid-url>`.
 */
export function legacyRedactPostgresURL(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "<invalid-url>";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    if (parsed.username === "") parsed.username = "redacted";
    parsed.password = "xxxxx";
  }
  return parsed.toString();
}

/** Port of Go's `formatConnectionInfo`: a single-line, password-redacted summary. */
export function legacyFormatConnectionInfo(
  conn: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
  },
  url: string,
): string {
  return `host=${conn.host} port=${conn.port} user=${conn.user} database=${conn.database} url=${legacyRedactPostgresURL(url)}`;
}

/** Object counts extracted from a pg-delta catalog JSON blob (Go's `CatalogSummary`). */
export interface LegacyCatalogSummary {
  readonly totalObjects: number;
  readonly bySchema: Record<string, number>;
}

/**
 * Best-effort counts catalog objects grouped by schema name. Port of Go's
 * `SummarizeCatalogJSON` / `walkCatalogObjects` (`internal/db/diff/pgdelta_debug.go`):
 * a node counts when it has a `schema` string or a `schema.name`, and children are
 * always recursed (so nested catalogs can contribute multiple counts, as in Go).
 */
export function legacySummarizeCatalogJson(catalogJson: string): LegacyCatalogSummary {
  const bySchema: Record<string, number> = {};
  let total = 0;
  if (catalogJson.trim().length === 0) return { totalObjects: 0, bySchema };
  let root: unknown;
  try {
    root = JSON.parse(catalogJson);
  } catch {
    return { totalObjects: 0, bySchema };
  }
  const schemaName = (node: Record<string, unknown>): string | undefined => {
    const schema = node["schema"];
    if (typeof schema === "string" && schema.length > 0) return schema;
    if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
      const name = (schema as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.length > 0) return name;
    }
    return undefined;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      const schema = schemaName(record);
      if (schema !== undefined) {
        total += 1;
        bySchema[schema] = (bySchema[schema] ?? 0) + 1;
      }
      for (const child of Object.values(record)) walk(child);
    }
  };
  walk(root);
  return { totalObjects: total, bySchema };
}

/** Port of Go's `formatCatalogSummary`. */
export function legacyFormatCatalogSummary(label: string, summary: LegacyCatalogSummary): string {
  if (summary.totalObjects === 0) return `${label} catalog: no objects detected`;
  const parts = Object.entries(summary.bySchema).map(([schema, count]) => `${schema}=${count}`);
  return `${label} catalog: ${summary.totalObjects} objects (${parts.join(", ")})`;
}

/** Port of Go's `formatByteSize` (`%.1f MB` / `%.1f KB` / `%d B`). */
export function legacyFormatByteSize(size: number): string {
  if (size >= 1 << 20) return `${(size / (1 << 20)).toFixed(1)} MB`;
  if (size >= 1 << 10) return `${(size / (1 << 10)).toFixed(1)} KB`;
  return `${size} B`;
}

/**
 * Builds the stderr summary block printed before the issue-report message. Port
 * of Go's `printEmptyPgDeltaPullSummary` (`internal/db/pull/pgdelta_pull_debug.go`).
 */
export function legacyFormatEmptyPgDeltaPullSummary(
  debugDir: string,
  sourceCatalog: string,
  targetCatalog: string,
): string {
  const lines = [
    "pg-delta returned 0 statements.",
    `Debug bundle saved to ${legacyBold(debugDir)}`,
  ];
  if (sourceCatalog.trim().length > 0) {
    lines.push(
      `${legacyFormatCatalogSummary("Shadow", legacySummarizeCatalogJson(sourceCatalog))} (${legacyFormatByteSize(byteLength(sourceCatalog))})`,
    );
  }
  if (targetCatalog.trim().length > 0) {
    lines.push(
      `${legacyFormatCatalogSummary("Remote", legacySummarizeCatalogJson(targetCatalog))} (${legacyFormatByteSize(byteLength(targetCatalog))})`,
    );
  } else {
    lines.push(
      "Remote catalog: export failed or empty (inspect connection.txt and pgdelta-stderr.txt)",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Saves the pg-delta empty-diff debug bundle and returns its directory. Port of
 * Go's `saveEmptyPgDeltaPullDebug` (`internal/db/pull/pgdelta_pull_debug.go`):
 * export the remote/target catalog (warn and continue on failure), write the
 * bundle (source/target catalog, stderr, connection.txt, error.txt), then print
 * the summary + issue-report message. The shadow source catalog and pg-delta
 * stderr are captured during the diff run and passed in.
 */
export const legacySaveEmptyPgDeltaPullDebug = Effect.fnUntraced(function* (params: {
  readonly ctx: LegacyPgDeltaContext;
  readonly conn: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
  };
  readonly targetUrl: string;
  readonly sourceCatalog: string | undefined;
  readonly pgDeltaStderr: string | undefined;
  readonly id: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
}) {
  const output = yield* Output;
  // Export the remote catalog at debug time (Go connects to the remote `config`
  // directly here, not the shadow); a failure only warns — the bundle is still
  // written with the catalogs/stderr captured during the diff.
  const targetCatalog = yield* legacyExportCatalogPgDelta(params.ctx, {
    targetRef: params.targetUrl,
    role: "postgres",
  }).pipe(
    Effect.catch((error) =>
      output
        .raw(`Warning: failed to export remote pg-delta catalog: ${error.message}\n`, "stderr")
        .pipe(Effect.as("")),
    ),
  );

  const bundle: LegacyDebugBundle = {
    id: params.id,
    connectionInfo: legacyFormatConnectionInfo(params.conn, params.targetUrl),
    error: ERR_IN_SYNC,
    ...(params.sourceCatalog !== undefined && params.sourceCatalog.length > 0
      ? { sourceCatalog: params.sourceCatalog }
      : {}),
    ...(targetCatalog.length > 0 ? { targetCatalog } : {}),
    ...(params.pgDeltaStderr !== undefined && params.pgDeltaStderr.length > 0
      ? { pgDeltaStderr: params.pgDeltaStderr }
      : {}),
  };
  const tempDir = legacyPgDeltaTempPath(params.path, params.workdir);
  const migrationsDir = params.path.join(params.workdir, "supabase", "migrations");
  const debugDir = yield* legacySaveDebugBundle(
    params.fs,
    params.path,
    params.workdir,
    tempDir,
    migrationsDir,
    bundle,
  );
  yield* output.raw(
    legacyFormatEmptyPgDeltaPullSummary(debugDir, params.sourceCatalog ?? "", targetCatalog),
    "stderr",
  );
  yield* output.raw(legacyDebugBundleMessage(debugDir), "stderr");
  return debugDir;
});
