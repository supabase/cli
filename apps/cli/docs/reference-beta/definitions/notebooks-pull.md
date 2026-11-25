---
id: notebooks-pull
kind: command
category: notebooks
subcategory: notebooks
title: notebooks pull
symbol: supabase notebooks pull
summary: Pull notebooks from a project
usage: supabase notebooks pull [Notebook id] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: Notebook id
    location: positional
    required: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Pull every notebook from the linked project
    lang: sh
    code: supabase notebooks pull
  - id: example-2
    title: Replace the local copy of one notebook by id
    lang: sh
    code: supabase notebooks pull 44444444-4444-4444-8444-444444444444
---

Write the notebooks of the linked project to `supabase/notebooks`.

Without a notebook id, existing local files are kept and only missing notebooks are written.
