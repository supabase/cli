---
id: init
kind: command
category: General
title: init
symbol: supabase init
summary: Set up a project for local development
usage: supabase init [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --force
    location: flag
    type: boolean
    description: Write a fresh supabase/config.toml, replacing an existing config.toml and removing any config.json or config.jsonc.
    default: false
  - name: --interactive
    location: flag
    type: boolean
    description: Prompt to generate IDE settings for Deno.
    default: false
    short: -i
  - name: --use-orioledb
    location: flag
    type: boolean
    description: Use the OrioleDB storage engine for Postgres.
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase init
    response: Finished supabase init.
  - id: from-workdir
    title: Initialize from an existing directory
    lang: sh
    code: supabase init --workdir .
    response: Finished supabase init.
  - id: with-orioledb
    title: Initialize with OrioleDB
    lang: sh
    code: supabase init --use-orioledb
    response: Finished supabase init.
---

Creates `supabase/config.toml` in the current directory, the starting point for local development with `supabase start`. Run it once in each project.

The `supabase` directory can also hold other project files, such as `migrations`, `functions`, and `tests`.

To use another directory, set the `SUPABASE_WORKDIR` environment variable or pass the `--workdir` flag.

To use OrioleDB as the Postgres storage engine, run `supabase init --use-orioledb`. The command writes the OrioleDB version to `db.orioledb_version` in `supabase/config.toml`; `--experimental` is not required.
