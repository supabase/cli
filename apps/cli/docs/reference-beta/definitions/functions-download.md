---
id: functions-download
kind: command
category: edge-functions
subcategory: functions
title: functions download
symbol: supabase functions download
summary: Download Edge Functions from a project
usage: supabase functions download [Function name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: Function name
    location: positional
    required: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --use-api
    location: flag
    type: boolean
    description: Unbundle functions server-side without using Docker.
    default: false
examples:
  - id: example-1
    title: Download a single function from the linked project
    lang: sh
    code: supabase functions download hello-world
  - id: example-2
    title: Download all functions from a specific project
    lang: sh
    code: supabase functions download --remote=abcdefghijklmnopqrst
---

Download the source code of deployed Edge Functions from the linked project. Downloads every function when you omit the name.
