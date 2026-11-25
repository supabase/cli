---
id: inspect-db
kind: command
category: inspect
subcategory: inspect
title: inspect db
symbol: supabase inspect db
summary: Inspect database
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples: []
---

Run diagnostics on locks, query performance, indexes, table sizes, vacuuming, and connections. Subcommands inspect the local database by default; pass --remote for the linked project, or --remote=<ref|branch|url> for another database.
