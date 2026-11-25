---
id: gen-types
kind: command
category: generate-types
subcategory: gen
title: gen types
symbol: supabase gen types
summary: Generate types from Postgres schema
usage: supabase gen types [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --lang
    location: flag
    type: "[ typescript | go | python | swift | dart ]"
    description: Output language of the generated types.
    default: typescript
    allowed_values:
      - typescript
      - go
      - python
      - swift
      - dart
  - name: --query-timeout
    location: flag
    type: string
    description: Maximum timeout allowed for the database query.
    default: 15s
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
  - name: --schema
    location: flag
    type: strings
    description: Comma-separated list of schemas to include.
    short: -s
    variadic: true
  - name: --swift-access-control
    location: flag
    type: "[ internal | public ]"
    description: Access control for Swift generated types.
    default: internal
    allowed_values:
      - internal
      - public
  - name: --swift-typegen-source
    location: flag
    type: string
    description: "Where to build supabase-typegen from: a supabase-swift version (3.0.0-alpha.1), a branch (main), a full commit SHA, or a local checkout (./supabase-swift). Default: the supabase-swift pin in the nearest Package.resolved, else the latest 3.x release."
examples:
  - id: example-1
    title: Generate types from the local dev database
    lang: sh
    code: supabase gen types
  - id: example-2
    title: Generate Go types from the linked project
    lang: sh
    code: supabase gen types --lang=go --remote
  - id: example-3
    title: Generate types from a project ref with specific schemas
    lang: sh
    code: supabase gen types --schema public --schema private --remote=abcdefghijklmnopqrst
  - id: example-4
    title: Generate types from a database URL
    lang: sh
    code: supabase gen types --schema public --schema auth --remote='postgresql://...'
---

Generate typed definitions for the tables, views and stored procedures in your Postgres schema, so your code gets type safety and autocompletion. TypeScript is the default output; Go and Swift are also supported.

By default the command reads the local database. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL.

The types respect the relationships, constraints and custom types defined in your schema.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`. `--project-id` is also deprecated; use `--remote=<ref>`.
