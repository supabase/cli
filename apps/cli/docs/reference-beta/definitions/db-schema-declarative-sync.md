---
id: db-schema-declarative-sync
kind: command
category: Database
title: db schema declarative sync
symbol: supabase db schema declarative sync
summary: Generate a migration from declarative schema
usage: supabase db schema declarative sync [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --apply
    location: flag
    type: boolean
    description: Apply the new migration to the local database without asking.
    default: false
  - name: --file
    location: flag
    type: string
    description: Name for the new migration file, used when --name is not set.
    default: declarative_sync
    short: -f
  - name: --name
    location: flag
    type: string
    description: Name for the new migration file.
  - name: --no-apply
    location: flag
    type: boolean
    description: Write the migration file without asking and without applying it to the local database.
    default: false
  - name: --schema
    location: flag
    type: strings
    description: Comma-separated list of schemas to include.
    short: -s
    variadic: true
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: false
  - name: --no-cache
    location: flag
    type: boolean
    description: Disable the catalog cache and force a fresh shadow database setup.
    default: false
  - name: --strict-coverage
    location: flag
    type: boolean
    description: Fail when pg-delta finds schema objects it cannot manage, instead of leaving them unmanaged.
    default: false
examples:
  - id: with-pg-delta
    title: Sync declarative schema with pg-delta
    lang: sh
    code: |
      # After editing declarative schema files, generate a migration:
      supabase db schema declarative sync --experimental
    response: |
      Creating shadow database...
      Applying declarative schemas via pg-delta...
      Applied 239 statements in 1 round(s).
      Enter a name for this migration (press Enter to keep 'declarative_sync'): add_updated_at
      Created new migration at supabase/migrations/20260317194051_add_updated_at.sql
      Apply this migration to local database? [Y/n]
      Target: local stack (127.0.0.1:54322)
      Applying migration 20260317194051_add_updated_at.sql...
      Migration applied successfully.
  - id: generate-first
    title: Generate declarative schema from migrations
    lang: sh
    code: |
      supabase db schema declarative sync --experimental
    response: |
      No declarative schema found. Generate a new one ? [Y/n]
      Reset local database to match migrations first? (local data will be lost) [y/N] y
      Resetting database...
      ...
      Declarative schema written to supabase/schemas
      Finished supabase db schema declarative generate.
---

Turn the changes you made in your declarative schema files into a new migration. It diffs the files against the current migration state.

When no declarative schema exists yet, the command offers to run `generate` first, exporting from the local database. To start from a linked project or a database URL, run `generate --remote` or `generate --remote=<url>` yourself first.

After computing the diff, you can optionally name the migration and apply it to the local database. This command is enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass `--experimental` to run it.
