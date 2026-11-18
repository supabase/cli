## supabase-gen-types

Generate typed definitions for the tables, views and stored procedures in your Postgres schema, so your code gets type safety and autocompletion. TypeScript is the default output; Go and Swift are also supported.

By default the command reads the local database. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL.

The types respect the relationships, constraints and custom types defined in your schema.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`. `--project-id` is also deprecated; use `--remote=<ref>`.
