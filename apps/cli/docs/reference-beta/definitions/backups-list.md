---
id: backups-list
kind: command
category: backups
subcategory: backups
title: backups list
symbol: supabase backups list
summary: List available physical backups
usage: supabase backups list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: List all physical backups
    lang: sh
    code: supabase backups list
  - id: example-2
    title: List backups for a specific project
    lang: sh
    code: supabase backups list --remote=<ref>
---

Show the backup status of a project, including the earliest and latest timestamps you can restore to. Use it to pick a timestamp for `supabase backups restore`.

Projects without PITR list their available backups instead.
