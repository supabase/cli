---
id: db-start
kind: command
category: Database
title: db start
symbol: supabase db start
summary: Start the local Postgres database
usage: supabase db start [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --from-backup
    location: flag
    type: string
    description: Path to a logical backup file to restore from.
examples:
  - id: example-1
    title: Start the local Postgres database
    lang: sh
    code: supabase db start
  - id: example-2
    title: Start the database and restore it from a logical backup
    lang: sh
    code: supabase db start --from-backup ./backup.sql
---

Start only the local Postgres container, without the rest of the Supabase stack. Use it when you just need a local database, for example to run migrations.
