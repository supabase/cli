---
id: branches-update
kind: command
category: branches
subcategory: branches
title: branches update
symbol: supabase branches update
summary: Update a preview branch
usage: supabase branches update [name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: false
  - name: --git-branch
    location: flag
    type: string
    description: New git branch to associate with the preview branch.
  - name: --name
    location: flag
    type: string
    description: New name for the preview branch.
  - name: --notify-url
    location: flag
    type: string
    description: URL to notify when the branch is active and healthy.
  - name: --persistent
    location: flag
    type: boolean
    description: Switch the branch between ephemeral and persistent.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref
    description: "Target another project: --remote=<ref>. Defaults to the linked project."
    default: false
  - name: --status
    location: flag
    type: string
    description: Override the current branch status.
    allowed_values:
      - RUNNING_MIGRATIONS
      - MIGRATIONS_PASSED
      - MIGRATIONS_FAILED
      - FUNCTIONS_DEPLOYED
      - FUNCTIONS_FAILED
examples:
  - id: example-1
    title: Rename a preview branch
    lang: sh
    code: supabase branches update my-branch --name renamed-branch
  - id: example-2
    title: Switch a branch between ephemeral and persistent
    lang: sh
    code: supabase branches update my-branch --persistent
---

Rename a preview branch, change its git branch or notify URL, or switch it between ephemeral and persistent.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
