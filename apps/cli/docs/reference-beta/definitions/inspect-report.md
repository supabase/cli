---
id: inspect-report
kind: command
category: inspect
subcategory: inspect
title: inspect report
symbol: supabase inspect report
summary: Export all inspect results as CSV files
usage: supabase inspect report [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --output-dir
    location: flag
    type: string
    description: Directory to create the dated report folder in.
    default: .
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: example-1
    title: Write CSV reports for the local database
    lang: sh
    code: supabase inspect report
  - id: example-2
    title: Write CSV reports for the linked project to ./reports
    lang: sh
    code: supabase inspect report --remote --output-dir ./reports
---

Run every inspect query and write each result to its own CSV file in a dated folder, then check the results against a set of rules and print a summary. It reports on the local database by default; pass --remote for the linked project, or --remote=<ref|branch|url> for another database.
