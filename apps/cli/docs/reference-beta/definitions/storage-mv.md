---
id: storage-mv
kind: command
category: Storage
title: storage mv
symbol: supabase storage mv
summary: Move objects within a Storage bucket
usage: supabase storage mv <src> <dst> [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: src
    location: positional
    required: true
  - name: dst
    location: positional
    required: true
  - name: --recursive
    location: flag
    type: boolean
    description: Recursively move a directory.
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
    title: Recursively move a directory within storage
    lang: sh
    code: supabase storage mv -r ss:///bucket/docs ss:///bucket/www/docs
---

Move or rename objects within a Storage bucket; moving between buckets is not supported.

The command asks for confirmation before changing anything. Requires the `--experimental` flag.
