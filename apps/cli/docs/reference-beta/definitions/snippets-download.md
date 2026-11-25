---
id: snippets-download
kind: command
category: sql-snippets
subcategory: snippets
title: snippets download
symbol: supabase snippets download
summary: Download a SQL snippet
usage: supabase snippets download <snippet-id> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: snippet-id
    location: positional
    required: true
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Download the SQL contents of the given snippet
    lang: sh
    code: supabase snippets download <snippet-id>
---

Print the SQL of a snippet to stdout, so you can redirect it to a file. JSON output returns the full snippet payload instead.
