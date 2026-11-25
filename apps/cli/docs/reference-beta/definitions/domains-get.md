---
id: domains-get
kind: command
category: custom-domains
subcategory: domains
title: domains get
symbol: supabase domains get
summary: Get the current custom hostname config
usage: supabase domains get [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Get the custom hostname config for a project
    lang: sh
    code: supabase domains get --remote=abcdefghijklmnopqrst
---

Checks where custom domain setup stands for your project, including any DNS records you still need to add.
