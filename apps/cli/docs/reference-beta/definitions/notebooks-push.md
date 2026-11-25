---
id: notebooks-push
kind: command
category: notebooks
subcategory: notebooks
title: notebooks push
symbol: supabase notebooks push
summary: Push local notebooks to a project
usage: supabase notebooks push [Notebook name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: Notebook name
    location: positional
    required: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Push every notebook in supabase/notebooks to the linked project
    lang: sh
    code: supabase notebooks push
  - id: example-2
    title: Push a single notebook by name
    lang: sh
    code: supabase notebooks push sales-dashboard
---

Upload the notebooks in `supabase/notebooks` to the linked project.

When you push all notebooks, the command asks what to do about project notebooks that the directory does not have.
