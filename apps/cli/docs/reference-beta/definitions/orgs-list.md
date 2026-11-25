---
id: orgs-list
kind: command
category: organizations
subcategory: orgs
title: orgs list
symbol: supabase orgs list
summary: List all organizations
usage: supabase orgs list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: List all organizations you belong to
    lang: sh
    code: supabase orgs list
  - id: example-2
    title: List organizations as JSON
    lang: sh
    code: supabase orgs list --output-format json
---

Show the organizations the logged-in user belongs to, with their IDs.
