---
id: feedback-add
kind: command
category: Feedback and Support
subcategory: feedback
title: feedback add
symbol: supabase feedback add
summary: Send feedback to the Supabase team
usage: supabase feedback add [message] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: message
    location: positional
    required: false
    variadic: true
  - name: --project-ref
    location: flag
    type: string
    description: Project ref to attribute the feedback to (defaults to SUPABASE_PROJECT_ID, then the linked project).
examples:
  - id: example-1
    title: Send quick feedback about a papercut in one line
    lang: sh
    code: supabase feedback add "when I run multiple stacks in parallel I get port conflicts"
  - id: example-2
    title: Use -- when the message starts with a dash
    lang: sh
    code: supabase feedback add -- "--yes should be the default in CI"
  - id: example-3
    title: Attribute the feedback to a project from an unlinked directory
    lang: sh
    code: supabase feedback add --project-ref abcdefghijklmnopqrst "branching is slow here"
---

Send a short note about a papercut, bug, or idea. The CLI prints a deletion token you can use to remove the feedback later.
