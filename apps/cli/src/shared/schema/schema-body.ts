import { formatTableRow } from "../output/table.ts";

export type SchemaScriptFile = {
  readonly name: string;
  readonly version?: string;
  readonly status?: string;
  readonly sql?: string;
};

export type MigrationInventoryStatus = "applied" | "pending" | "remote-only";

export type MigrationInventoryRow = {
  readonly version: string;
  readonly name: string;
  readonly status?: MigrationInventoryStatus;
};

export function formatPlanSql(plan: {
  readonly files: ReadonlyArray<{ readonly sql: string }>;
}): string {
  return plan.files.map((file) => file.sql).join("\n\n");
}

export function planStatementCount(plan: {
  readonly files: ReadonlyArray<{ readonly sql: string }>;
  readonly plan?: { readonly actions: ReadonlyArray<unknown> };
}): number {
  if (plan.plan !== undefined && plan.plan.actions.length > 0) {
    return plan.plan.actions.length;
  }
  return formatPlanSql(plan)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0).length;
}

export function formatMigrationInventory(rows: ReadonlyArray<MigrationInventoryRow>): string {
  if (rows.length === 0) return "";
  const withStatus = rows.some((row) => row.status !== undefined);
  const cells = rows.map((row) =>
    withStatus ? [row.version, row.name, row.status ?? ""] : [row.version, row.name],
  );
  const colCount = withStatus ? 3 : 2;
  const widths = Array.from({ length: colCount }, (_, index) =>
    Math.max(...cells.map((cell) => cell[index]?.length ?? 0)),
  );
  return cells.map((cell) => formatTableRow(cell, widths).trimEnd()).join("\n");
}

export function humanTarget(
  target: "local" | "linked" | "url" | { readonly kind: "local" | "linked" | "url" },
): string {
  const kind = typeof target === "string" ? target : target.kind;
  switch (kind) {
    case "local":
      return "the local database";
    case "linked":
      return "the linked project";
    case "url":
      return "the given database";
  }
}
