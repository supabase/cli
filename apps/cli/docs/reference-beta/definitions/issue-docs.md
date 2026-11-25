---
id: issue-docs
kind: command
category: Feedback and Support
subcategory: issue
title: issue docs
symbol: supabase issue docs
summary: Open a documentation issue
usage: supabase issue docs [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --additional-context
    location: flag
    type: string
    description: Extra context to prefill on the form.
  - name: --improvement
    location: flag
    type: string
    description: Suggested improvement to the documentation.
  - name: --issue-type
    location: flag
    type: string
    description: Documentation issue type.
  - name: --link
    location: flag
    type: string
    description: Relevant documentation link.
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the form URL without opening a browser.
    default: false
  - name: --problem
    location: flag
    type: string
    description: What is confusing, missing, or incorrect.
examples:
  - id: example-1
    title: Open a prefilled documentation issue
    lang: sh
    code: supabase issue docs --link "https://supabase.com/docs/guides/cli" --problem "The flag description is outdated"
---

Report documentation that is confusing, missing, or incorrect.
