import { s } from "jsonv-ts";

const links = {
  postgres: {
    name: "PostgreSQL configuration",
    link: "https://postgrest.org/en/stable/configuration.html",
  },
  pgbouncer: (id?: string) => ({
    name: "PgBouncer Configuration",
    link: `https://www.pgbouncer.org/config.html${id ? `#${id}` : ""}`,
  }),
};

const tags = ["database"];

export const db = s
  .strictObject({
    port: s.number({
      default: 54322,
      description: "Port to use for the local database URL.",
      tags,
      links: [links.postgres],
    }),
    shadow_port: s.number({
      default: 54320,
      description: "Port to use for the local shadow database.",
      tags,
    }),
    major_version: s.number({
      default: 15,
      description:
        "The database major version to use. This has to be the same as your remote database's. Run `SHOW server_version;` on the remote database to check.",
      tags,
      links: [links.postgres],
    }),
    pooler: s
      .strictObject({
        enabled: s.boolean({
          default: false,
          description: "Enable the local PgBouncer service.",
          tags,
          links: [links.pgbouncer()],
        }),
        port: s.number({
          default: 54329,
          description: "Port to use for the local connection pooler.",
          tags,
          links: [links.pgbouncer("listen_port")],
        }),
        pool_mode: s.string({
          enum: ["transaction", "session"],
          default: "transaction",
          description:
            "Specifies when a server connection can be reused by other clients. Configure one of the supported pooler modes: `transaction`, `session`.",
          tags,
          links: [links.pgbouncer("pool_mode")],
        }),
        default_pool_size: s.number({
          default: 20,
          description: "How many server connections to allow per user/database pair.",
          tags,
          links: [links.pgbouncer("default_pool_size")],
        }),
        max_client_conn: s.number({
          default: 100,
          description: "Maximum number of client connections allowed.",
          tags,
          links: [links.pgbouncer("max_client_conn")],
        }),
      })
      .partial(),
    seed: s
      .strictObject({
        enabled: s.boolean({
          default: true,
          description: "Enable seeding the database with SQL files.",
          tags,
        }),
        sql_paths: s.array(
          s.string({
            description: "Path to a SQL file to seed the database with.",
            tags,
          }),
          {
            default: ["./seed.sql"],
            description:
              "Paths to SQL files to seed the database with. Supports glob patterns relative to supabase directory.",
            examples: [["./seeds/*.sql", "../project-src/seeds/*-load-testing.sql"]],
            tags,
          },
        ),
      })
      .partial(),
  })
  .partial();
