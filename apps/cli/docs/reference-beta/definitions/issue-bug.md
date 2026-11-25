---
id: issue-bug
kind: command
category: Feedback and Support
subcategory: issue
title: issue bug
symbol: supabase issue bug
summary: Open a bug report
usage: supabase issue bug [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --actual-output
    location: flag
    type: string
    description: Actual output or error text.
  - name: --additional-context
    location: flag
    type: string
    description: Extra context to prefill on the form.
  - name: --area
    location: flag
    type: string
    description: Affected CLI area.
  - name: --command
    location: flag
    type: string
    description: Command that failed.
  - name: --crash-report-id
    location: flag
    type: string
    description: Crash report or support ticket ID, if you have one.
  - name: --docker-services
    location: flag
    type: string
    description: Relevant Docker service status or logs.
  - name: --expected-behavior
    location: flag
    type: string
    description: What you expected to happen.
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the form URL without opening a browser.
    default: false
  - name: --reproduce
    location: flag
    type: string
    description: Steps to reproduce the problem.
examples:
  - id: example-1
    title: Open a prefilled bug report for a failing command
    lang: sh
    code: supabase issue bug --command "supabase start" --actual-output "database failed to start"
  - id: example-2
    title: Print a prefilled issue URL with a crash report ID
    lang: sh
    code: supabase issue bug --crash-report-id "abc123" --no-browser
---

Report a problem with the CLI. The form opens with your local CLI details already filled in.
