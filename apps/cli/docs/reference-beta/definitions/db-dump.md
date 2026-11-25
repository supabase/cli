---
id: db-dump
kind: command
category: Database
title: db dump
symbol: supabase db dump
summary: Dump data or schemas from a database
usage: supabase db dump [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --data-only
    location: flag
    type: boolean
    description: Dump only data records.
    default: false
  - name: --dry-run
    location: flag
    type: boolean
    description: Print the pg_dump script that would run, without running it.
    default: false
  - name: --exclude
    location: flag
    type: strings
    description: Comma-separated list of schema.table names to exclude from a data-only dump.
    short: -x
    variadic: true
  - name: --file
    location: flag
    type: string
    description: File path to save the dumped contents to.
    short: -f
  - name: --keep-comments
    location: flag
    type: boolean
    description: Keep commented lines from the pg_dump output.
    default: false
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
  - name: --role-only
    location: flag
    type: boolean
    description: Dump only cluster roles.
    default: false
  - name: --schema
    location: flag
    type: strings
    description: Comma-separated list of schemas to include.
    short: -s
    variadic: true
  - name: --use-copy
    location: flag
    type: boolean
    description: Use COPY statements instead of INSERT statements.
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase db dump -f supabase/schema.sql
    response: |
      Target: local stack (127.0.0.1:54322)
      Dumping schemas from local database...
      Dumped schema to supabase/schema.sql.
  - id: linked-project
    title: Dump the linked project
    lang: sh
    code: supabase db dump -f supabase/schema.sql --remote
    response: |
      Target: project My Project (abcdefghijklmnopqrst) · production
      Dumping schemas from remote database...
      Dumped schema to supabase/schema.sql.
  - id: role-only
    title: Role only
    lang: sh
    code: supabase db dump -f supabase/roles.sql --role-only --remote
    response: |
      Target: project My Project (abcdefghijklmnopqrst) · production
      Dumping roles from remote database...
      Dumped schema to supabase/roles.sql.
  - id: data-only
    title: Data only
    lang: sh
    code: supabase db dump -f supabase/seed.sql --data-only --remote
    response: |
      Target: project My Project (abcdefghijklmnopqrst) · production
      Dumping data from remote database...
      Dumped schema to supabase/seed.sql.
---

Export the schema of a database as a SQL script, or its data or custom roles with `--data-only` and `--role-only`. Use it to back up a database or to copy it to another project.

It dumps the local database by default. Pass `--remote` to dump the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to dump another project, a branch of the linked project, or a database URL such as a self-hosted database.

The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

The command runs `pg_dump` in a container and excludes Supabase-managed schemas, including `auth`, `storage`, and those created by extensions. The default dump contains neither data nor custom roles.

### Note on privilege migration

When you restore to a new project, tables inherit ALL privileges from the default privileges in the target database. To keep specific privileges from your dump, revoke the defaults before restoring:

```sql
-- Run BEFORE restoring your schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```
