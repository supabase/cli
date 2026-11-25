---
id: storage-cp
kind: command
category: storage
subcategory: storage
title: storage cp
symbol: supabase storage cp
summary: Copy files between local disk and Storage
usage: supabase storage cp <src> <dst> [flags]
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
  - name: --cache-control
    location: flag
    type: string
    description: Custom Cache-Control header for HTTP upload.
    default: max-age=3600
  - name: --content-type
    location: flag
    type: string
    description: Custom Content-Type header for HTTP upload.
    default: auto-detect
  - name: --jobs
    location: flag
    type: integer
    description: Maximum number of parallel jobs.
    default: "1"
    short: -j
  - name: --recursive
    location: flag
    type: boolean
    description: Recursively copy a directory.
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
    title: Upload a local file to storage
    lang: sh
    code: supabase storage cp readme.md ss:///bucket/readme.md
  - id: example-2
    title: Upload a directory recursively to storage
    lang: sh
    code: supabase storage cp -r docs ss:///bucket/docs
  - id: example-3
    title: Download a directory from storage
    lang: sh
    code: supabase storage cp -r ss:///bucket/docs .
---

Upload local files to Storage, or download objects from Storage to local disk. Exactly one side must be a `ss:///bucket/path` URL; copying between buckets is not supported.

Requires the `--experimental` flag.
