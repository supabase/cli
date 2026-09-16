import { describe, expect, it } from "vitest";

import { dropObjectsSql } from "../../../command-internal/drop-objects.ts";
import { EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL } from "../../../command-internal/edge-runtime-script.service.ts";
import { migraDiffScript } from "./migra.deno-templates.ts";
import { listSchemasSql } from "./migra.ts";

describe("embedded migra templates", () => {
  it("emit the error sentinel from the diff script's failure path", () => {
    expect(migraDiffScript).toContain(EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL);
  });
});

describe("embedded user-schema queries", () => {
  it.each([
    ["listSchemasSql", listSchemasSql],
    ["dropObjectsSql", dropObjectsSql],
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
