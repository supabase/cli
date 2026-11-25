---
id: bootstrap
kind: command
category: general
title: bootstrap
symbol: supabase bootstrap
summary: Create a project from a starter template
usage: supabase bootstrap [template] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: template
    location: positional
    required: false
  - name: --password
    location: flag
    type: string
    description: Password for the new project's Postgres database.
    short: -p
examples:
  - id: example-1
    title: Pick a starter template interactively
    lang: sh
    code: supabase bootstrap
  - id: example-2
    title: Bootstrap from a named starter template
    lang: sh
    code: supabase bootstrap my-template
---

Create a new hosted Supabase project from a starter template and link it to a local directory. Use it to go from nothing to a running project with one command.

The command prompts for a working directory, downloads the template, creates the project, links it, writes its connection settings to `.env`, and pushes the template's migrations. It logs you in first if needed.

Creating a project is a hosted change, so the command asks for confirmation before it starts.
