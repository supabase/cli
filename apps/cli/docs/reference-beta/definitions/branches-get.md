---
id: branches-get
kind: command
category: branches
subcategory: branches
title: branches get
symbol: supabase branches get
summary: Show details of a preview branch
usage: supabase branches get [name] [flags]
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
    title: Show the details of a preview branch
    lang: sh
    code: supabase branches get my-branch
  - id: example-2
    title: Show the details as JSON
    lang: sh
    code: supabase branches get my-branch --output-format json
---

Show the details of a preview branch, including its connection settings.

For the main branch, the password-dependent fields (POSTGRES_URL, POSTGRES_URL_NON_POOLING) are not populated because production database credentials cannot be retrieved through the API.
