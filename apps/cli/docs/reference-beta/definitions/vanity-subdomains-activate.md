---
id: vanity-subdomains-activate
kind: command
category: Vanity Subdomains
title: vanity-subdomains activate
symbol: supabase vanity-subdomains activate
summary: Activate a vanity subdomain
usage: supabase vanity-subdomains activate [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --desired-subdomain
    location: flag
    type: string
    required: true
    description: The vanity subdomain to use for the project.
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
    title: Activate a vanity subdomain for a project
    lang: sh
    code: supabase vanity-subdomains activate --desired-subdomain my-app --experimental --remote=<project-ref>
---

Makes your project respond to requests on the vanity subdomain you choose. After activation, your project's auth services no longer work on the `{project-ref}.{supabase-domain}` hostname.
