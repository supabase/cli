---
id: ssl-enforcement-update
kind: command
category: ssl-enforcement
subcategory: ssl-enforcement
title: ssl-enforcement update
symbol: supabase ssl-enforcement update
summary: Update SSL enforcement configuration
usage: supabase ssl-enforcement update [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --disable-db-ssl-enforcement
    location: flag
    type: boolean
    description: Stop requiring SSL for external database connections.
    default: false
  - name: --enable-db-ssl-enforcement
    location: flag
    type: boolean
    description: Require SSL for all external database connections.
    default: false
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
    title: Require SSL for database connections
    lang: sh
    code: supabase ssl-enforcement update --enable-db-ssl-enforcement --experimental --remote=<project-ref>
  - id: example-2
    title: Stop requiring SSL for database connections
    lang: sh
    code: supabase ssl-enforcement update --disable-db-ssl-enforcement --experimental --remote=<project-ref>
---

Turns SSL enforcement on or off for external database connections. Pass exactly one of `--enable-db-ssl-enforcement` or `--disable-db-ssl-enforcement`.
