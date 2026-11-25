---
id: functions-delete
kind: command
category: edge-functions
subcategory: functions
title: functions delete
symbol: supabase functions delete
summary: Delete an Edge Function from a project
usage: supabase functions delete <Function name> [flags]
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
    title: Delete a deployed function from the linked project
    lang: sh
    code: supabase functions delete hello-world
  - id: example-2
    title: Delete a deployed function from a specific project
    lang: sh
    code: supabase functions delete hello-world --remote=abcdefghijklmnopqrst
---

Delete a deployed Edge Function from the linked project. Your local copy in `supabase/functions` is not removed.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
