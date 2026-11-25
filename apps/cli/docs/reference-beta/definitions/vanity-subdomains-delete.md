---
id: vanity-subdomains-delete
kind: command
category: Vanity Subdomains
title: vanity-subdomains delete
symbol: supabase vanity-subdomains delete
summary: Delete the vanity subdomain
usage: supabase vanity-subdomains delete [flags]
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
    title: Delete the vanity subdomain of a project
    lang: sh
    code: supabase vanity-subdomains delete --experimental --remote=<project-ref>
---

Removes the vanity subdomain, so requests are routed by project ref again.
