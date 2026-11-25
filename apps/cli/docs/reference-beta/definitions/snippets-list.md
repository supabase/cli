---
id: snippets-list
kind: command
category: sql-snippets
subcategory: snippets
title: snippets list
symbol: supabase snippets list
summary: List all SQL snippets
usage: supabase snippets list [flags]
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
    title: List all SQL snippets
    lang: sh
    code: supabase snippets list
  - id: example-2
    title: List snippets for a specific project
    lang: sh
    code: supabase snippets list --remote=<ref>
---

Show the SQL snippets of the linked project. Use it to find the ID that `snippets download` needs.
