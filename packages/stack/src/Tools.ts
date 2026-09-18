import { Schema } from "effect";

export const PostgresTool = Schema.Struct({
  command: Schema.Literals(["pg_dump", "pg_dumpall", "psql"]),
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
  psql: ({ major }: { readonly major: 15 | 17 }): PostgresTool => ({ command: "psql", major }),
};
