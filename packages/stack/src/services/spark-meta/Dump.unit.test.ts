import { describe, expect, it } from "@effect/vitest";
import type { Description } from "./Description.ts";
import { renderDump } from "./Dump.ts";

const column = (name: string) => ({
  name,
  position: 1,
  type: "uuid",
  not_null: true,
  default: null,
  identity: null,
  generated: null,
  comment: null,
});

const table = (
  name: string,
  extra: Partial<Description["tables"][number]> = {},
): Description["tables"][number] => ({
  schema: "app",
  name,
  managed: false,
  rls_enabled: false,
  rls_forced: false,
  comment: null,
  columns: [column("id")],
  constraints: [],
  indexes: [],
  policies: [],
  ...extra,
});

const describeTables = (...tables: Description["tables"]): Description => ({
  schema_version: "1",
  managed_schemas: [],
  schemas: [{ name: "app", comment: null }],
  enums: [],
  tables,
  views: [],
});

describe("renderDump", () => {
  it("qualifies and quotes a foreign key target written without a schema", () => {
    const dump = renderDump(
      describeTables(
        table("a"),
        table("b", {
          constraints: [
            {
              name: "b_a_id_fkey",
              type: "f",
              def: "FOREIGN KEY (a_id) REFERENCES a(id) ON DELETE CASCADE",
              columns: ["a_id"],
              references: { schema: "app", table: "a", columns: ["id"] },
            },
          ],
        }),
      ),
    );

    expect(dump).toContain(
      'alter table "app"."b" add constraint "b_a_id_fkey" FOREIGN KEY (a_id) REFERENCES "app"."a" (id) ON DELETE CASCADE;',
    );
  });

  it("renders only the exact role name public as the keyword and quotes other roles", () => {
    const policy = (name: string, roles: ReadonlyArray<string>) => ({
      name,
      cmd: "select",
      permissive: true,
      roles,
      using: "true",
      check: null,
    });
    const dump = renderDump(
      describeTables(
        table("a", {
          policies: [policy("p_public", ["Public"]), policy("p_auth", ["authenticated", "public"])],
        }),
      ),
    );

    expect(dump).toContain('"p_public" on "app"."a" as permissive for select to "Public" using');
    expect(dump).toContain('to "authenticated", PUBLIC using');
  });

  it("creates a unique index before the foreign key that targets it", () => {
    const dump = renderDump(
      describeTables(
        table("a", {
          indexes: [
            {
              name: "a_code_key",
              def: "CREATE UNIQUE INDEX a_code_key ON app.a USING btree (code)",
              unique: true,
              constraint: null,
            },
          ],
        }),
        table("b", {
          constraints: [
            {
              name: "b_code_fkey",
              type: "f",
              def: "FOREIGN KEY (code) REFERENCES a(code)",
              columns: ["code"],
              references: { schema: "app", table: "a", columns: ["code"] },
            },
          ],
        }),
      ),
    );

    expect(dump.indexOf("CREATE UNIQUE INDEX a_code_key")).toBeLessThan(
      dump.indexOf('add constraint "b_code_fkey"'),
    );
  });

  it("keeps views whose schema and name only differ by where the dot falls", () => {
    const view = (
      schema: string,
      name: string,
      dependsOn: Description["views"][number]["depends_on"],
    ) => ({
      schema,
      name,
      def: "select 1",
      depends_on: dependsOn,
      comment: null,
    });
    const dump = renderDump({
      ...describeTables(),
      schemas: [],
      views: [
        view("a.b", "c", []),
        view("a", "b.c", []),
        view("a", "z", [{ schema: "a.b", name: "c" }]),
      ],
    });

    expect(dump.match(/^create view /gmu)).toHaveLength(3);
  });
});
