---
id: branches-list
kind: command
category: Branches
title: branches list
symbol: supabase branches list
summary: List all preview branches
usage: supabase branches list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref
    description: "Target another project: --remote=<ref>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: List all preview branches of the linked project
    lang: sh
    code: supabase branches list
  - id: example-2
    title: List preview branches as JSON
    lang: sh
    code: supabase branches list --output-format json
---

Show the preview branches of the linked project. Use it to find the name or ID that the other `branches` commands take.
