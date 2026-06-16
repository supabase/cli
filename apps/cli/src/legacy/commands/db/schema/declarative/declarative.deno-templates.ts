// Verbatim copies of the Go pg-delta Deno templates. These embed the scripts
// byte-for-byte; `declarative.deno-templates.unit.test.ts` asserts equality
// against the Go `.ts` sources. Do not hand-edit — regenerate from Go.
//
// Four templates back the in-scope flows: diff / declarative-export / catalog-
// export live in `apps/cli-go/internal/db/diff/templates/`, and the declarative
// *apply* template (used by `getDeclarativeCatalogRef` → `pgdelta.ApplyDeclarative`
// to build the declarative target catalog on the shadow database) lives in
// `apps/cli-go/internal/pgdelta/templates/`. The migra.* templates back the
// non-pgdelta diff path, which declarative commands never reach.
//
// Each template pins `npm:@supabase/pg-delta@1.0.0-alpha.20` as a placeholder
// that `legacyInterpolatePgDeltaScript` rewrites to the effective npm version
// (`apps/cli-go/pkg/config/pgdelta_version.go`).

/** `templates/pgdelta.ts` — diffs SOURCE→TARGET and prints SQL statements. */
export const legacyPgDeltaDiffScript =
  'import {\n  createPlan,\n  deserializeCatalog,\n  formatSqlStatements,\n} from "npm:@supabase/pg-delta@1.0.0-alpha.20";\nimport { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.20/integrations/supabase";\n\nasync function resolveInput(ref: string | undefined) {\n  if (!ref) {\n    return null;\n  }\n  if (ref.startsWith("postgres://") || ref.startsWith("postgresql://")) {\n    return ref;\n  }\n  const json = await Deno.readTextFile(ref);\n  return deserializeCatalog(JSON.parse(json));\n}\n\nconst source = Deno.env.get("SOURCE");\nconst target = Deno.env.get("TARGET");\n\nconst includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");\nif (includedSchemas) {\n  const schemas = includedSchemas.split(",");\n  const schemaFilter = {\n    or: [{ "*/schema": schemas }, { "schema/name": schemas }],\n  };\n  // CompositionPattern `and` is valid FilterDSL; Deno\'s structural typing is strict on `or` branches.\n  supabase.filter = {\n    and: [supabase.filter!, schemaFilter],\n  } as typeof supabase.filter;\n}\n\nconst formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");\nlet formatOptions = undefined;\nif (formatOptionsRaw) {\n  formatOptions = JSON.parse(formatOptionsRaw);\n}\n\ntry {\n  const result = await createPlan(\n    await resolveInput(source),\n    await resolveInput(target),\n    {\n      ...supabase,\n      skipDefaultPrivilegeSubtraction: true,\n    },\n  );\n  let statements = result?.plan.statements ?? [];\n  if (formatOptions != null) {\n    statements = formatSqlStatements(statements, formatOptions);\n  }\n  if (Deno.env.get("PGDELTA_DEBUG")) {\n    console.error(\n      JSON.stringify({\n        statementCount: statements.length,\n        source: source ? "connected" : "null",\n        target: target ? "connected" : "null",\n        includedSchemas: includedSchemas ?? null,\n        skipDefaultPrivilegeSubtraction: true,\n      }),\n    );\n  }\n  for (const sql of statements) {\n    console.log(`${sql};`);\n  }\n} catch (e) {\n  console.error(e);\n  // Force close event loop\n  throw new Error("");\n}\n';

/** `templates/pgdelta_declarative_export.ts` — exports declarative file payloads. */
export const legacyPgDeltaDeclarativeExportScript =
  '// This script is executed inside Edge Runtime by the CLI to export a target\n// schema as declarative file payloads. It accepts either live DB URLs or\n// catalog-file references for SOURCE/TARGET, which enables cached sync flows.\nimport {\n  createPlan,\n  deserializeCatalog,\n  exportDeclarativeSchema,\n} from "npm:@supabase/pg-delta@1.0.0-alpha.20";\nimport { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.20/integrations/supabase";\n\nasync function resolveInput(ref: string | undefined) {\n  if (!ref) {\n    return null;\n  }\n  if (ref.startsWith("postgres://") || ref.startsWith("postgresql://")) {\n    return ref;\n  }\n  const json = await Deno.readTextFile(ref);\n  return deserializeCatalog(JSON.parse(json));\n}\n\nconst source = Deno.env.get("SOURCE");\nconst target = Deno.env.get("TARGET");\n\nconst includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");\nif (includedSchemas) {\n  const schemas = includedSchemas.split(",");\n  const schemaFilter = {\n    or: [{ "*/schema": schemas }, { "schema/name": schemas }],\n  };\n  supabase.filter = {\n    and: [supabase.filter!, schemaFilter],\n  } as unknown as typeof supabase.filter;\n}\n\nconst formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");\nlet formatOptions = undefined;\nif (formatOptionsRaw) {\n  formatOptions = JSON.parse(formatOptionsRaw);\n}\ntry {\n  const result = await createPlan(\n    await resolveInput(source),\n    await resolveInput(target),\n    {\n      ...supabase,\n      skipDefaultPrivilegeSubtraction: true,\n    },\n  );\n  if (!result) {\n    console.log(\n      JSON.stringify({\n        version: 1,\n        mode: "declarative",\n        files: [],\n      }),\n    );\n  } else {\n    const output = exportDeclarativeSchema(result, {\n      integration: supabase,\n      formatOptions,\n    });\n    console.log(\n      JSON.stringify(output, (_key, value) =>\n        typeof value === "bigint" ? Number(value) : value,\n      ),\n    );\n  }\n} catch (e) {\n  console.error(e);\n  // Force close event loop\n  throw new Error("");\n}\n';

/** `templates/pgdelta_catalog_export.ts` — serializes a catalog snapshot for caching. */
export const legacyPgDeltaCatalogExportScript =
  '// This script serializes a database catalog for caching/reuse in declarative\n// sync workflows, so later diff/export operations can run from file references.\nimport {\n  createManagedPool,\n  extractCatalog,\n  serializeCatalog,\n  stringifyCatalogSnapshot,\n} from "npm:@supabase/pg-delta@1.0.0-alpha.20";\n\nconst target = Deno.env.get("TARGET");\nconst role = Deno.env.get("ROLE") ?? undefined;\n\nif (!target) {\n  console.error("TARGET is required");\n  throw new Error("");\n}\nconst { pool, close } = await createManagedPool(target, { role });\n\ntry {\n  const catalog = await extractCatalog(pool);\n  console.log(stringifyCatalogSnapshot(serializeCatalog(catalog)));\n} catch (e) {\n  console.error(e);\n  throw new Error("");\n} finally {\n  await close();\n}\n';

/** `internal/pgdelta/templates/pgdelta_declarative_apply.ts` — applies declarative files to TARGET. */
export const legacyPgDeltaDeclarativeApplyScript =
  '// This script applies declarative schema files to a target database and emits\n// structured JSON so the Go caller can report success/failure deterministically.\nimport {\n  applyDeclarativeSchema,\n  loadDeclarativeSchema,\n} from "npm:@supabase/pg-delta@1.0.0-alpha.20/declarative";\n\nconst schemaPath = Deno.env.get("SCHEMA_PATH");\nconst target = Deno.env.get("TARGET");\n\nif (!schemaPath) {\n  throw new Error("SCHEMA_PATH is required");\n}\nif (!target) {\n  throw new Error("TARGET is required");\n}\n\ntry {\n  const content = await loadDeclarativeSchema(schemaPath);\n  if (content.length === 0) {\n    console.log(JSON.stringify({ status: "success", totalStatements: 0 }));\n  } else {\n    const result = await applyDeclarativeSchema({\n      content,\n      targetUrl: target,\n    });\n    const apply = result?.apply;\n    if (!apply) {\n      throw new Error("pg-delta apply returned no result");\n    }\n    const payload = {\n      status: apply.status,\n      totalStatements: result.totalStatements ?? 0,\n      totalRounds: apply.totalRounds ?? 0,\n      totalApplied: apply.totalApplied ?? 0,\n      totalSkipped: apply.totalSkipped ?? 0,\n      errors: apply.errors ?? [],\n      stuckStatements: apply.stuckStatements ?? [],\n      // validationErrors is populated when the final\n      // check_function_bodies=on pass catches issues that didn\'t surface during\n      // the initial apply rounds (e.g. a function body that references a\n      // column whose type changed). Without surfacing this field, callers see\n      // status=error with empty errors/stuckStatements and no actionable info.\n      validationErrors: apply.validationErrors ?? [],\n      diagnostics: result.diagnostics ?? [],\n    };\n    console.log(JSON.stringify(payload));\n    if (apply.status !== "success") {\n      throw new Error("pg-delta apply failed with status: " + apply.status);\n    }\n  }\n} catch (e) {\n  throw e instanceof Error ? e : new Error(String(e));\n}\n';

/**
 * The npm dist-tag/version used for `@supabase/pg-delta` when
 * `supabase/.temp/pgdelta-version` (the `[experimental.pgdelta].npm_version`
 * config field) is absent or empty. Mirrors Go's `DefaultPgDeltaNpmVersion`
 * (`apps/cli-go/pkg/config/pgdelta_version.go:7`).
 */
export const LEGACY_DEFAULT_PG_DELTA_NPM_VERSION = "1.0.0-alpha.27";

/**
 * The literal version baked into the embedded templates above, replaced by
 * `legacyInterpolatePgDeltaScript`. Mirrors Go's `pgDeltaNpmVersionPlaceholder`
 * (`apps/cli-go/pkg/config/pgdelta_version.go:9`).
 */
export const LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER = "1.0.0-alpha.20";

/**
 * Returns the pg-delta npm version from config, or the default when unset.
 * Mirrors Go's `EffectivePgDeltaNpmVersion`
 * (`apps/cli-go/pkg/config/pgdelta_version.go:13`).
 */
export function legacyEffectivePgDeltaNpmVersion(npmVersion: string | undefined): string {
  const trimmed = npmVersion?.trim();
  return trimmed !== undefined && trimmed.length > 0
    ? trimmed
    : LEGACY_DEFAULT_PG_DELTA_NPM_VERSION;
}

/**
 * Substitutes the pg-delta npm version placeholder in an embedded template.
 * Mirrors Go's `InterpolatePgDeltaScript`
 * (`apps/cli-go/pkg/config/pgdelta_version.go:26`).
 */
export function legacyInterpolatePgDeltaScript(
  script: string,
  npmVersion: string | undefined,
): string {
  return script.replaceAll(
    LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER,
    legacyEffectivePgDeltaNpmVersion(npmVersion),
  );
}
