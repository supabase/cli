---
id: network-restrictions-get
kind: command
category: network-restrictions
subcategory: network-restrictions
title: network-restrictions get
symbol: supabase network-restrictions get
summary: Get the current network restrictions
usage: supabase network-restrictions get [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Show the allowed CIDR ranges for a project
    lang: sh
    code: supabase network-restrictions get --experimental --remote=<project-ref>
---

Shows the CIDR ranges allowed to connect to your project's database, and whether they are applied.
