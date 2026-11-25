---
id: branches-pause
kind: command
category: branches
subcategory: branches
title: branches pause
symbol: supabase branches pause
summary: Pause a preview branch
usage: supabase branches pause [name] [flags]
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
    title: Pause a preview branch
    lang: sh
    code: supabase branches pause my-branch
---

Pause a preview branch you are not using; resume it later with `supabase branches unpause`.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
