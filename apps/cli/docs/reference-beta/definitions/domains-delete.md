---
id: domains-delete
kind: command
category: Custom Domains
title: domains delete
symbol: supabase domains delete
summary: Delete the custom hostname config
usage: supabase domains delete [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Delete the custom hostname config for a project
    lang: sh
    code: supabase domains delete --remote=abcdefghijklmnopqrst
---

Removes the custom hostname configuration so the project is served only on its Supabase-provisioned domain. Use it to start over, or to move to a vanity subdomain.
