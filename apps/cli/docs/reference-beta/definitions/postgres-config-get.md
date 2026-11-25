---
id: postgres-config-get
kind: command
category: postgres-config
subcategory: postgres-config
title: postgres-config get
symbol: supabase postgres-config get
summary: Get Postgres database config
usage: supabase postgres-config get [flags]
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
    title: Show the Postgres config overrides of a project
    lang: sh
    code: supabase postgres-config get --experimental --remote=<project-ref>
---

Shows the custom Postgres settings you have set for your project.
