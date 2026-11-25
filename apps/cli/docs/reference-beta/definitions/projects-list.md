---
id: projects-list
kind: command
category: projects
subcategory: projects
title: projects list
symbol: supabase projects list
summary: List all projects
usage: supabase projects list [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: List all projects
    lang: sh
    code: supabase projects list
  - id: example-2
    title: Machine-readable JSON output
    lang: sh
    code: supabase projects list --output-format json
---

Show the projects the logged-in user can access. The project linked to the current directory is marked.
