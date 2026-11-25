---
id: seed-buckets
kind: command
category: seed
subcategory: seed
title: seed buckets
symbol: supabase seed buckets
summary: Seed Storage buckets from the project config file
usage: supabase seed buckets [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target a remote Storage API: the linked project, or --remote=<ref|branch>."
    default: false
examples:
  - id: example-1
    title: Seed buckets on the local stack
    lang: sh
    code: supabase seed buckets
  - id: example-2
    title: Seed buckets on the linked project
    lang: sh
    code: supabase seed buckets --remote
---

Create or update the Storage buckets declared in the project config file and upload the files from each bucket's objects_path. A remote project asks for confirmation before the first write.
