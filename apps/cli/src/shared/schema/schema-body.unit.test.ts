import { describe, expect, it } from "vitest";
import {
  formatMigrationInventory,
  formatPlanSql,
  humanTarget,
  planStatementCount,
} from "./schema-body.ts";

describe("formatPlanSql", () => {
  it("joins file sql with a blank line", () => {
    expect(
      formatPlanSql({
        files: [{ sql: "CREATE TABLE t (id int);" }, { sql: "ALTER TABLE t ADD COLUMN n int;" }],
      }),
    ).toBe("CREATE TABLE t (id int);\n\nALTER TABLE t ADD COLUMN n int;");
  });

  it("returns empty when there are no files", () => {
    expect(formatPlanSql({ files: [] })).toBe("");
  });
});

describe("planStatementCount", () => {
  it("prefers plan.actions when present", () => {
    expect(
      planStatementCount({
        files: [{ sql: "CREATE TABLE t (id int);" }],
        plan: { actions: [{}, {}] },
      }),
    ).toBe(2);
  });

  it("counts statements from joined SQL when actions are empty", () => {
    expect(
      planStatementCount({
        files: [{ sql: "CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN n int;" }],
        plan: { actions: [] },
      }),
    ).toBe(2);
  });
});

describe("formatMigrationInventory", () => {
  it("formats version, name, and status as aligned columns", () => {
    expect(
      formatMigrationInventory([
        { version: "20240101000000", name: "init", status: "applied" },
        { version: "20240102000000", name: "add_users", status: "pending" },
        { version: "20240103000000", name: "from_ci", status: "remote-only" },
      ]),
    ).toBe(
      [
        "20240101000000  init       applied",
        "20240102000000  add_users  pending",
        "20240103000000  from_ci    remote-only",
      ].join("\n"),
    );
  });

  it("omits the status column when no row has one", () => {
    expect(formatMigrationInventory([{ version: "20240101000000", name: "init" }])).toBe(
      "20240101000000  init",
    );
  });

  it("returns empty for no rows", () => {
    expect(formatMigrationInventory([])).toBe("");
  });
});

describe("humanTarget", () => {
  it("names local, linked, and url targets", () => {
    expect(humanTarget("local")).toBe("the local database");
    expect(humanTarget({ kind: "linked" })).toBe("the linked project");
    expect(humanTarget({ kind: "url" })).toBe("the given database");
  });
});
