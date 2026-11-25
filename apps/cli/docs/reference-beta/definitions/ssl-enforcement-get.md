---
id: ssl-enforcement-get
kind: command
category: ssl-enforcement
subcategory: ssl-enforcement
title: ssl-enforcement get
symbol: supabase ssl-enforcement get
summary: Get SSL enforcement configuration
usage: supabase ssl-enforcement get [flags]
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
    title: Show the SSL enforcement setting of a project
    lang: sh
    code: supabase ssl-enforcement get --experimental --remote=<project-ref>
---

Shows whether SSL enforcement is enabled for external database connections.
