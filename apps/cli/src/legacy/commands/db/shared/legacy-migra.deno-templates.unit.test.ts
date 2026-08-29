import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  legacyMigraDiffScript,
  legacyMigraDiffShellScript,
} from "./legacy-migra.deno-templates.ts";

// Resolve the Go template sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goDiffTemplatesDir = fileURLToPath(
  new URL("../../../../../../cli-go/internal/db/diff/templates/", import.meta.url),
);
const readGoTemplate = (name: string) => readFileSync(`${goDiffTemplatesDir}${name}`, "utf8");

describe("embedded migra templates", () => {
  it("match the Go sources byte-for-byte", () => {
    expect(legacyMigraDiffScript).toBe(readGoTemplate("migra.ts"));
    expect(legacyMigraDiffShellScript).toBe(readGoTemplate("migra.sh"));
  });

  it("emit the error sentinel from the diff script's failure path", () => {
    expect(legacyMigraDiffScript).toContain(LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL);
  });
});

// The user-schema listing predicate is hand-copied across four modules —
// drift between the copies caused supabase/cli#6375.
const CLASSID_CONSTRAINT =
  "left join pg_catalog.pg_depend pd on pd.objid = pn.oid and pd.classid = 'pg_catalog.pg_namespace'::regclass";

const SCHEMA_LISTING_SOURCES: ReadonlyArray<[label: string, relPath: string]> = [
  ["legacy-drop-schemas.ts", "./legacy-drop-schemas.ts"],
  ["legacy-drop-objects.ts", "../../../shared/legacy-drop-objects.ts"],
  ["lint.lint-sql.ts", "../lint/lint.lint-sql.ts"],
  ["legacy-migra.ts", "./legacy-migra.ts"],
];

const readSchemaListingSource = (relPath: string) =>
  readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");

function extractSqlLiteral(source: string, name: string): string {
  const match = new RegExp(`${name} = \`([\\s\\S]*?)\`;`).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`missing template literal '${name}'`);
  }
  return match[1].replaceAll("\\\\", "\\").trimEnd();
}

describe("embedded user-schema listing queries", () => {
  it.each(SCHEMA_LISTING_SOURCES)(
    "%s constrains the pg_depend anti-join to pg_namespace rows (supabase/cli#6375)",
    (_label, relPath) => {
      const source = readSchemaListingSource(relPath);
      expect(source).toContain(CLASSID_CONSTRAINT);
      // an unconstrained copy of the join must never reappear
      expect(source).not.toMatch(
        /left join pg_(catalog\.pg_)?depend pd on pd\.objid = pn\.oid\s*$/m,
      );
    },
  );

  it("keeps the two drop DO blocks identical to each other", () => {
    expect(
      extractSqlLiteral(readSchemaListingSource("./legacy-drop-schemas.ts"), "DROP_OBJECTS"),
    ).toBe(
      extractSqlLiteral(
        readSchemaListingSource("../../../shared/legacy-drop-objects.ts"),
        "LEGACY_DROP_OBJECTS_SQL",
      ),
    );
  });

  it("keeps the two list queries identical to each other", () => {
    expect(
      extractSqlLiteral(
        readSchemaListingSource("../lint/lint.lint-sql.ts"),
        "LEGACY_LIST_SCHEMAS_SQL",
      ),
    ).toBe(
      extractSqlLiteral(readSchemaListingSource("./legacy-migra.ts"), "LEGACY_LIST_SCHEMAS_SQL"),
    );
  });
});
