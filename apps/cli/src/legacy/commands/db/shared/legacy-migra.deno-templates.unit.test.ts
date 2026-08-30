import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LEGACY_DROP_OBJECTS_SQL } from "../../../shared/legacy-drop-objects.ts";
import { LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  legacyMigraDiffScript,
  legacyMigraDiffShellScript,
} from "./legacy-migra.deno-templates.ts";
import { LEGACY_LIST_SCHEMAS_SQL } from "./legacy-migra.ts";

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

describe("embedded user-schema queries", () => {
  // An unscoped pg_depend anti-join hid user schemas whose oid collided with a
  // row in another catalog (supabase/cli#6375).
  it.each([
    ["LEGACY_LIST_SCHEMAS_SQL", LEGACY_LIST_SCHEMAS_SQL],
    ["LEGACY_DROP_OBJECTS_SQL", LEGACY_DROP_OBJECTS_SQL],
  ])(
    "%s constrains the pg_depend anti-join to pg_namespace rows (supabase/cli#6375)",
    (_name, sql) => {
      // normalize whitespace so a cosmetic re-wrap of the join cannot fail this
      const normalized = sql.replaceAll(/\s+/gu, " ");
      const joins = normalized.match(/pd\.objid = pn\.oid/gu) ?? [];
      const constrained =
        normalized.match(
          /pd\.objid = pn\.oid and pd\.classid = 'pg_catalog\.pg_namespace'::regclass/gu,
        ) ?? [];
      expect(joins.length).toBeGreaterThan(0);
      expect(constrained).toHaveLength(joins.length);
    },
  );
});
