---
id: branches-delete
kind: command
category: branches
subcategory: branches
title: branches delete
symbol: supabase branches delete
summary: Delete a preview branch
usage: supabase branches delete [name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: false
  - name: --remote
    location: flag
    type: boolean | ref
    description: "Target another project: --remote=<ref>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Delete a preview branch
    lang: sh
    code: supabase branches delete my-branch
  - id: example-2
    title: Delete a preview branch without the confirmation prompt
    lang: sh
    code: supabase branches delete my-branch --yes
---

Remove a preview branch you no longer need from the linked project.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
