---
id: orgs-create
kind: command
category: Organizations
title: orgs create
symbol: supabase orgs create
summary: Create an organization
usage: supabase orgs create <name> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: true
examples:
  - id: example-1
    title: Create an organization
    lang: sh
    code: supabase orgs create "My Organization"
---

Create a new organization under your account, which you can then create projects in.
