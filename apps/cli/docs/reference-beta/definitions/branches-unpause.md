---
id: branches-unpause
kind: command
category: Branches
title: branches unpause
symbol: supabase branches unpause
summary: Unpause a preview branch
usage: supabase branches unpause [name] [flags]
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
    title: Resume a paused preview branch
    lang: sh
    code: supabase branches unpause my-branch
---

Resume a paused preview branch so you can use it again.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
