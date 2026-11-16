import { Schema } from "effect";

/** Spark's schema description (`GET /_spark/v1/schema`); fields as the admin API contract names them. */
export const Column = Schema.Struct({
  name: Schema.String,
  position: Schema.Finite,
  type: Schema.String,
  not_null: Schema.Boolean,
  default: Schema.NullOr(Schema.String),
  identity: Schema.NullOr(Schema.Literals(["a", "d"])),
  generated: Schema.NullOr(Schema.String),
  comment: Schema.NullOr(Schema.String),
});
export interface Column extends Schema.Schema.Type<typeof Column> {}

export const Constraint = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["p", "u", "f", "c"]),
  def: Schema.String,
  columns: Schema.Array(Schema.String),
  references: Schema.NullOr(
    Schema.Struct({
      schema: Schema.String,
      table: Schema.String,
      columns: Schema.Array(Schema.String),
    }),
  ),
});
export interface Constraint extends Schema.Schema.Type<typeof Constraint> {}

const Index = Schema.Struct({
  name: Schema.String,
  def: Schema.String,
  unique: Schema.Boolean,
  constraint: Schema.NullOr(Schema.String),
});

const Policy = Schema.Struct({
  name: Schema.String,
  cmd: Schema.String,
  permissive: Schema.Boolean,
  roles: Schema.Array(Schema.String),
  using: Schema.NullOr(Schema.String),
  check: Schema.NullOr(Schema.String),
});

export const Table = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  managed: Schema.Boolean,
  rls_enabled: Schema.Boolean,
  rls_forced: Schema.Boolean,
  comment: Schema.NullOr(Schema.String),
  columns: Schema.Array(Column),
  constraints: Schema.Array(Constraint),
  indexes: Schema.Array(Index),
  policies: Schema.Array(Policy),
});
export interface Table extends Schema.Schema.Type<typeof Table> {}

export const Enum = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  comment: Schema.NullOr(Schema.String),
});
export interface Enum extends Schema.Schema.Type<typeof Enum> {}

export const View = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  def: Schema.String,
  depends_on: Schema.Array(Schema.Struct({ schema: Schema.String, name: Schema.String })),
  comment: Schema.NullOr(Schema.String),
});
export interface View extends Schema.Schema.Type<typeof View> {}

export const Description = Schema.Struct({
  schema_version: Schema.String,
  managed_schemas: Schema.Array(Schema.String),
  schemas: Schema.Array(
    Schema.Struct({ name: Schema.String, comment: Schema.NullOr(Schema.String) }),
  ),
  enums: Schema.Array(Enum),
  tables: Schema.Array(Table),
  views: Schema.Array(View),
});
export interface Description extends Schema.Schema.Type<typeof Description> {}

export const SchemaVersion = Schema.Struct({ schema_version: Schema.String });

export const Migration = Schema.Struct({
  version: Schema.String,
  name: Schema.String,
  statements: Schema.NullOr(Schema.Array(Schema.String)),
});
export interface Migration extends Schema.Schema.Type<typeof Migration> {}

const StatementStatus = Schema.Struct({
  index: Schema.Finite,
  kind: Schema.String,
  status: Schema.String,
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  line: Schema.optionalKey(Schema.Finite),
});

export const ScratchResult = Schema.Struct({ statuses: Schema.Array(StatementStatus) });

export type Row = Record<string, unknown>;
