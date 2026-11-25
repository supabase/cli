---
id: migration-fetch
kind: command
category: migrations
subcategory: migration
title: migration fetch
symbol: supabase migration fetch
summary: Fetch migration files from a database
usage: supabase migration fetch [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: Write the migration history of the linked project to supabase/migrations
    lang: sh
    code: supabase migration fetch --remote
---

Download the migrations recorded in a database's migration history table and write them to supabase/migrations. Use it when the history of a project is missing from your local files.
