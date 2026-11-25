---
id: backups-restore
kind: command
category: Backups
title: backups restore
symbol: supabase backups restore
summary: Restore a project to a point in time
usage: supabase backups restore [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --timestamp
    location: flag
    type: int
    description: Recovery target time, as a Unix timestamp in seconds.
    default: "0"
    short: -t
examples:
  - id: example-1
    title: Restore to the given Unix epoch timestamp
    lang: sh
    code: supabase backups restore --timestamp 1707407047
---

Restore the project database to a point in time using PITR. Changes made after that time are lost.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
