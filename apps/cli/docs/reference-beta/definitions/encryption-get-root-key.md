---
id: encryption-get-root-key
kind: command
category: encryption
subcategory: encryption
title: encryption get-root-key
symbol: supabase encryption get-root-key
summary: Get the root encryption key
usage: supabase encryption get-root-key [flags]
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
    title: Print the root encryption key of the linked project
    lang: sh
    code: supabase encryption get-root-key
---

Print the root encryption key of the project. Treat the output as a secret.
