---
id: storage-ls
kind: command
category: Storage
title: storage ls
symbol: supabase storage ls
summary: List objects by path prefix
usage: supabase storage ls [path] [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: path
    location: positional
    required: false
  - name: --recursive
    location: flag
    type: boolean
    description: Recursively list a directory.
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
    title: List objects at a storage path
    lang: sh
    code: supabase storage ls ss:///bucket/docs
---

List the objects under a Storage path such as `ss:///bucket/docs`. Without a path, it lists all buckets.

Requires the `--experimental` flag.
