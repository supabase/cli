---
id: db-push
kind: command
category: Database
title: db push
symbol: supabase db push
summary: Push new migrations to a database
usage: supabase db push [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --dry-run
    location: flag
    type: boolean
    description: Print the migrations that would be applied, without applying them.
    default: false
  - name: --include-all
    location: flag
    type: boolean
    description: Include all migrations not found in the migration history table.
    default: false
  - name: --include-roles
    location: flag
    type: boolean
    description: Include custom roles from supabase/roles.sql.
    default: false
  - name: --include-seed
    location: flag
    type: boolean
    description: Include seed data from your config.
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
  - name: --skip-vault
    location: flag
    type: boolean
    description: Skip updating vault secrets from the project config file.
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase db push --remote
    response: |
      Remote database is up to date.
  - id: self-hosted
    title: Self hosted
    lang: sh
    code: supabase db push --remote="postgres://user:pass@db.example.com:5432/postgres"
    response: |
      Pushing migration 20230410135622_create_employees_table.sql...
      Finished supabase db push.
  - id: dry-run
    title: Dry run
    lang: sh
    code: supabase db push --dry-run --remote
    response: |
      DRY RUN: migrations will *not* be pushed to the database.
      Would push migration 20230410135622_create_employees_table.sql...
      Would push migration 20230425064254_my_table.sql...
      Finished supabase db push.
---

Apply the local migrations that a database has not run yet. Use it to deploy schema changes to a linked project or another database.

It pushes to the local database by default. Pass `--remote` to push to the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to push to another project, a branch of the linked project, or a database URL such as a self-hosted database.

In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Before changing a hosted database, the command lists what it will do (migrations, custom roles, seed files and vault secrets) and asks once for confirmation, defaulting to No. Pass `--yes` to confirm without a prompt; JSON output, piped input and agent runs need it. A `SUPABASE_YES` set in `supabase/.env` does not confirm, but one set in your shell does.

The first run creates a migration history table at `supabase_migrations.schema_migrations`. After each migration is applied, a row with its timestamp as the unique id is added to the table, so later pushes skip migrations that were already applied.

To change the migration history table without running migrations, such as deleting entries or inserting new ones, use the `migration repair` command. Use `--dry-run` to see the list of changes before applying them.
