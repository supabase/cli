---
id: projects-delete
kind: command
category: projects
subcategory: projects
title: projects delete
symbol: supabase projects delete
summary: Delete a project
usage: supabase projects delete [ref] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: ref
    location: positional
    required: false
examples:
  - id: example-1
    title: Delete a project by ref
    lang: sh
    code: supabase projects delete abcdefghijklmnopqrst
---

Delete a Supabase project by its ref. In an interactive terminal, omit the ref to pick a project from a list.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
