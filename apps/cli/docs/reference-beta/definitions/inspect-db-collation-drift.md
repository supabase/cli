---
id: inspect-db-collation-drift
kind: command
category: Inspect
title: inspect db collation-drift
symbol: supabase inspect db collation-drift
summary: Show indexes affected by collation version drift
usage: supabase inspect db collation-drift [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: List drifted indexes on the local database
    lang: sh
    code: supabase inspect db collation-drift
  - id: example-2
    title: List drifted indexes on the linked project
    lang: sh
    code: supabase inspect db collation-drift --remote
---

Show indexes affected by collation version drift, with the fix workflow.

Postgres stores btree indexes on text columns in sorted order, using rules from
the system collation library (glibc or ICU). When that library is upgraded the
rules can change, and indexes built under the old rules are no longer correctly
ordered. Postgres reports no error: queries may quietly return missing rows,
sort incorrectly, or let duplicates past a unique constraint.

The output lists the affected indexes and the exact statements to verify
(amcheck), rebuild (REINDEX CONCURRENTLY), and record the new version — in the
order they must be run. This command itself is read-only.
