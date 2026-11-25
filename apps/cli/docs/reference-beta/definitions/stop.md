---
id: stop
kind: command
category: General
title: stop
symbol: supabase stop
summary: Stop the local Supabase stack
usage: supabase stop [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --all
    location: flag
    type: boolean
    description: Stop the local Supabase stacks of every project on this machine.
    default: false
  - name: --no-backup
    location: flag
    type: boolean
    description: Delete all data volumes after stopping.
    default: false
  - name: --project-id
    location: flag
    type: string
    description: Local project ID to stop.
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase stop
    response: |
      Stopped supabase local development setup.
      Local data are backed up to docker volume.
  - id: clean-up
    title: Clean up local data after stopping
    lang: sh
    code: supabase stop --no-backup
    response: |
      Stopped supabase local development setup.
---

Stops the containers of the local development stack. Requires a `supabase/config.toml`, which `supabase init` creates.

Docker volumes are kept, so your data survives a restart. Pass `--no-backup` to delete them and reset your local data.

Pass `--all` to stop every local Supabase project on the machine. Take care combining it with `--no-backup`, which deletes the data of all of them.
