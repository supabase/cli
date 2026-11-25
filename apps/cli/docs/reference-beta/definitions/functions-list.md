---
id: functions-list
kind: command
category: Edge Functions
title: functions list
symbol: supabase functions list
summary: List deployed Edge Functions
usage: supabase functions list [flags]
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
    title: List all deployed functions in the linked project
    lang: sh
    code: supabase functions list
  - id: example-2
    title: List all deployed functions in a specific project
    lang: sh
    code: supabase functions list --remote=abcdefghijklmnopqrst
---

Show the Edge Functions deployed to the linked project.
