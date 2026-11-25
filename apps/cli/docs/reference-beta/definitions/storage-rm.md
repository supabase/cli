---
id: storage-rm
kind: command
category: Storage
title: storage rm
symbol: supabase storage rm
summary: Remove objects from Storage
usage: supabase storage rm <file> ... [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: file
    location: positional
    required: true
    variadic: true
  - name: --recursive
    location: flag
    type: boolean
    description: Recursively remove a directory.
    default: false
    short: -r
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target a remote Storage API: the linked project, or --remote=<ref|branch>."
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Recursively remove a directory from storage
    lang: sh
    code: supabase storage rm -r ss:///bucket/docs
  - id: example-2
    title: Remove multiple files from storage
    lang: sh
    code: supabase storage rm ss:///bucket/docs/example.md ss:///bucket/readme.md
---

Remove one or more objects from Storage. Pass `-r` to remove directories.

The command asks for confirmation before deleting. Requires the `--experimental` flag.
