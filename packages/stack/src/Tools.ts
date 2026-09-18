import { Schema } from "effect";

const PgProveMount = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
});

export const PgProveOptions = Schema.Struct({
  mounts: Schema.Array(PgProveMount),
  cwd: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
});
export interface PgProveOptions extends Schema.Schema.Type<typeof PgProveOptions> {}

export const PostgresTool = Schema.Struct({
  command: Schema.Literals(["pg_dump", "pg_dumpall", "pg_prove", "psql"]),
  major: Schema.Literals([15, 17]),
});
export interface PostgresTool extends Schema.Schema.Type<typeof PostgresTool> {}

/** Describes finite PostgreSQL clients without managing a database service. */
export const postgres = {
  pgDump: ({ major }: { readonly major: 15 | 17 }): PostgresTool => ({ command: "pg_dump", major }),
  pgDumpAll: ({ major }: { readonly major: 15 | 17 }): PostgresTool => ({
    command: "pg_dumpall",
    major,
  }),
  pgProve: ({ major }: { readonly major: 15 | 17 }): PostgresTool => ({
    command: "pg_prove",
    major,
  }),
  psql: ({ major }: { readonly major: 15 | 17 }): PostgresTool => ({ command: "psql", major }),
};
