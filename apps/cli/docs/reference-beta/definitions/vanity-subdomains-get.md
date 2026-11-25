---
id: vanity-subdomains-get
kind: command
category: Vanity Subdomains
title: vanity-subdomains get
symbol: supabase vanity-subdomains get
summary: Get the current vanity subdomain
usage: supabase vanity-subdomains get [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Show the vanity subdomain of a project
    lang: sh
    code: supabase vanity-subdomains get --experimental --remote=<project-ref>
---

Shows the vanity subdomain configured for your project, along with its status.
