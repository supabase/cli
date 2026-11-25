---
id: migration-new
kind: command
category: migrations
subcategory: migration
title: migration new
symbol: supabase migration new
summary: Create an empty migration file
usage: supabase migration new <migration name> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: migration name
    location: positional
    required: true
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase migration new schema_test
    response: |
      Created new migration at supabase/migrations/20230306095710_schema_test.sql.
  - id: pipe-stdin
    title: With statements piped from stdin
    lang: sh
    code: echo "create schema if not exists test;" | supabase migration new schema_test
    response: |
      Created new migration at supabase/migrations/20230306095710_schema_test.sql.
---

Create an empty migration file for you to fill in. Output from other commands, such as `db diff`, can be piped to `migration new <name>` through stdin.

The command creates the `supabase/migrations` directory in your current `workdir` if it does not exist. Every migration file in this directory is named `<timestamp>_<name>.sql`.
