---
id: issue-feature
kind: command
category: Feedback and Support
subcategory: issue
title: issue feature
symbol: supabase issue feature
summary: Open a feature request
usage: supabase issue feature [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --additional-context
    location: flag
    type: string
    description: Extra context to prefill on the form.
  - name: --alternatives
    location: flag
    type: string
    description: Alternatives you considered.
  - name: --area
    location: flag
    type: string
    description: Affected CLI area.
  - name: --existing-issues
    location: flag
    type: boolean
    description: Prefill the checklist item for having searched existing issues.
    default: false
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the form URL without opening a browser.
    default: false
  - name: --problem
    location: flag
    type: string
    description: Problem the feature should solve.
  - name: --proposed-solution
    location: flag
    type: string
    description: Solution you would like to see.
examples:
  - id: example-1
    title: Open a prefilled feature request
    lang: sh
    code: supabase issue feature --existing-issues --problem "I need to rotate local secrets" --proposed-solution "Add a secrets rotate command"
---

Propose a new CLI feature or an improvement to an existing one.
