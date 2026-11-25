---
id: vanity-subdomains-check-availability
kind: command
category: Vanity Subdomains
title: vanity-subdomains check-availability
symbol: supabase vanity-subdomains check-availability
summary: Check subdomain availability
usage: supabase vanity-subdomains check-availability [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --desired-subdomain
    location: flag
    type: string
    required: true
    description: The vanity subdomain to check.
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
    title: Check whether a subdomain is available
    lang: sh
    code: supabase vanity-subdomains check-availability --desired-subdomain my-app --experimental --remote=<project-ref>
---

Tells you whether a subdomain is free to use. Run it before `supabase vanity-subdomains activate`.
