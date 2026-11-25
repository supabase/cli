---
id: migration-list
kind: command
category: Migrations
title: migration list
symbol: supabase migration list
summary: List local and applied migrations
usage: supabase migration list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --password
    location: flag
    type: string
    description: Database password for the project selected with --remote; ignored for the local database and database URLs.
    short: -p
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase migration list --remote
    response: |2
            LOCAL      │     REMOTE     │     TIME (UTC)
      ─────────────────┼────────────────┼──────────────────────
                       │ 20230103054303 │ 2023-01-03 05:43:03
                       │ 20230103093141 │ 2023-01-03 09:31:41
        20230222032233 │                │ 2023-02-22 03:22:33
  - id: with-db-url
    title: Connect to self-hosted database
    lang: sh
    code: supabase migration list --remote='postgres://postgres[:percent_encoded_password]@db.example.com[:port]/postgres'
    response: |2
            LOCAL      │     REMOTE     │     TIME (UTC)
      ─────────────────┼────────────────┼──────────────────────
        20230103054303 │ 20230103054303 │ 2023-01-03 05:43:03
        20230103093141 │ 20230103093141 │ 2023-01-03 09:31:41
---

Compare the migration files in `supabase/migrations` with the migration history of a database. Use it to see which migrations are missing on either side.

It lists the local database by default. Pass `--remote` to list the linked project instead, which requires running `supabase link`. Pass `--remote=<ref|branch|url>` to list another project, a branch of the linked project, or a database URL such as a self-hosted database.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

> Note that URL strings must be escaped according to [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).

The target database tracks applied migrations in the `supabase_migrations.schema_migrations` table. The second column is headed `Remote` for a project or database URL passed with `--remote`, and `Local DB` for the local database. Only the timestamps are compared to identify differences.

If the local and remote migration history differ, you can resolve them with the `migration repair` command.
