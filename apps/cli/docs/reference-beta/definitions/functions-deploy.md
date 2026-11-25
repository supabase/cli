---
id: functions-deploy
kind: command
category: edge-functions
subcategory: functions
title: functions deploy
symbol: supabase functions deploy
summary: Deploy Edge Functions to a project
usage: supabase functions deploy [Function name] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: Function name
    location: positional
    required: false
    variadic: true
  - name: --import-map
    location: flag
    type: string
    description: Path to an import map file.
  - name: --jobs
    location: flag
    type: int
    description: Maximum number of parallel jobs.
    default: "1"
    short: -j
  - name: --no-verify-jwt
    location: flag
    type: boolean
    description: Disable JWT verification for the function.
    default: false
  - name: --prune
    location: flag
    type: boolean
    description: Delete functions that exist in the project but not locally.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --use-api
    location: flag
    type: boolean
    description: Bundle functions server-side without using Docker.
    default: false
examples:
  - id: example-1
    title: Deploy a single function to the linked project
    lang: sh
    code: supabase functions deploy hello-world
  - id: example-2
    title: Deploy all local functions to a specific project
    lang: sh
    code: supabase functions deploy --remote=abcdefghijklmnopqrst
---

Deploy local Edge Functions to the linked project. Deploys every function in `supabase/functions` unless you name specific ones.

With `--prune`, functions that exist in the project but not locally are deleted. Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
