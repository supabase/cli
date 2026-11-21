import type { Column, Constraint, Description, Enum, Table } from "./Description.ts";

/** A stable synthetic oid: the generator metadata keys tables, columns and types by oid. */
const oid = (key: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return 16384 + (hash % 2_000_000_000);
};

const UDT: Readonly<Record<string, string>> = {
  bigint: "int8",
  integer: "int4",
  smallint: "int2",
  boolean: "bool",
  "double precision": "float8",
  real: "float4",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "character varying": "varchar",
  character: "bpchar",
  bit: "bit",
  "bit varying": "varbit",
};

const baseType = (type: string) => type.replace(/\(.*?\)/u, "").trim();

export interface TypeInfo {
  readonly data_type: string;
  readonly format: string;
  readonly format_schema: string;
  readonly enum: Enum | undefined;
  readonly array: boolean;
  readonly base: string;
}

export const typeInfo = (description: Description, type: string): TypeInfo => {
  // Postgres names an array type `_<element>` whatever its dimensions.
  const element = type.replace(/(?:\s*\[\d*\])+$/u, "");
  const array = element !== type;
  const inner = baseType(element);
  const found = description.enums.find(
    (e) =>
      inner === `${e.schema}.${e.name}` ||
      (e.schema === "public" && inner === e.name) ||
      inner === `"${e.schema}"."${e.name}"`,
  );
  const udt = found === undefined ? (UDT[inner] ?? inner) : found.name;
  return {
    data_type: array ? "ARRAY" : found === undefined ? inner : "USER-DEFINED",
    format: array ? `_${udt}` : udt,
    format_schema: found === undefined ? "pg_catalog" : found.schema,
    enum: found,
    array,
    base: udt,
  };
};

interface Named {
  readonly schema: string;
  readonly name: string;
}

interface ForeignKey {
  readonly table: Table;
  readonly constraint: Constraint;
  readonly references: NonNullable<Constraint["references"]>;
}

/** pg-meta object shapes for one description, as the TypeScript generator reads them. */
export const makeModel = (description: Description) => {
  const tableId = (t: Named) => oid(`${t.schema}.${t.name}`);
  const column = (t: Table, c: Column) => {
    const info = typeInfo(description, c.type);
    const unique = t.constraints.some(
      (k) => k.type === "u" && k.columns.length === 1 && k.columns[0] === c.name,
    );
    const check = t.constraints.find(
      (k) => k.type === "c" && k.columns.length === 1 && k.columns[0] === c.name,
    );
    return {
      table_id: tableId(t),
      schema: t.schema,
      table: t.name,
      id: `${tableId(t)}.${c.position}`,
      ordinal_position: c.position,
      name: c.name,
      default_value: c.identity === null ? c.default : null,
      data_type: info.data_type,
      format: info.format,
      format_schema: info.format_schema,
      is_identity: c.identity !== null,
      identity_generation:
        c.identity === "a"
          ? ("ALWAYS" as const)
          : c.identity === "d"
            ? ("BY DEFAULT" as const)
            : null,
      is_generated: c.generated !== null && c.generated !== "",
      is_nullable: !c.not_null,
      is_updatable: true,
      is_unique: unique,
      check: check === undefined ? null : check.def.slice(7, -1),
      enums: info.enum?.labels ?? [],
      comment: c.comment,
    };
  };
  const foreignKeys: ReadonlyArray<ForeignKey> = description.tables.flatMap((table) =>
    table.constraints.flatMap((constraint) =>
      constraint.type === "f" && constraint.references !== null
        ? [{ table, constraint, references: constraint.references }]
        : [],
    ),
  );
  const primaryKeys = (t: Table) =>
    (t.constraints.find((k) => k.type === "p")?.columns ?? []).map((name) => ({
      schema: t.schema,
      table_name: t.name,
      name,
      table_id: tableId(t),
    }));
  const types = () =>
    description.enums.map((e) => ({
      id: oid(`type.${e.schema}.${e.name}`),
      name: e.name,
      schema: e.schema,
      format: e.schema === "public" ? e.name : `${e.schema}.${e.name}`,
      enums: e.labels,
      attributes: [],
      comment: e.comment,
    }));
  const schemas = () =>
    [
      ...new Set([
        ...description.schemas.map((s) => s.name),
        ...description.managed_schemas,
        "public",
      ]),
    ].map((name) => ({
      id: oid(`schema.${name}`),
      name,
      owner: description.managed_schemas.includes(name) ? "supabase_admin" : "postgres",
      comment: description.schemas.find((s) => s.name === name)?.comment ?? null,
    }));
  return { description, tableId, column, foreignKeys, primaryKeys, types, schemas };
};

export type Model = ReturnType<typeof makeModel>;
