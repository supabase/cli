---
id: network-restrictions-update
kind: command
category: Network Restrictions
title: network-restrictions update
symbol: supabase network-restrictions update
summary: Update network restrictions
usage: supabase network-restrictions update [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --append
    location: flag
    type: boolean
    description: Append to existing restrictions instead of replacing them.
    default: false
  - name: --bypass-cidr-checks
    location: flag
    type: boolean
    description: Allow private IP ranges that CIDR validation would otherwise reject.
    default: false
  - name: --db-allow-cidr
    location: flag
    type: strings
    description: CIDR range allowed to connect to the database, comma-separated or repeated.
    variadic: true
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
    title: Replace the allowed CIDR ranges
    lang: sh
    code: supabase network-restrictions update --db-allow-cidr 203.0.113.0/24 --experimental --remote=<project-ref>
  - id: example-2
    title: Add a CIDR range to the existing ones
    lang: sh
    code: supabase network-restrictions update --db-allow-cidr 198.51.100.0/24 --append --experimental --remote=<project-ref>
---

Sets the CIDR ranges allowed to connect to your project's database. By default the ranges you pass replace the existing ones; use `--append` to add to them.
