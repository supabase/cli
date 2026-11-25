---
id: domains-create
kind: command
category: Custom Domains
title: domains create
symbol: supabase domains create
summary: Create a custom hostname
usage: supabase domains create [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --custom-hostname
    location: flag
    type: string
    required: true
    description: The custom hostname to use for the project.
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Create a custom hostname for a project
    lang: sh
    code: supabase domains create --custom-hostname example.com --remote=abcdefghijklmnopqrst
---

Starts custom domain setup for your project. Before you run it, add a CNAME record from your hostname to your project's Supabase subdomain. Then run `supabase domains reverify` until verification completes, and `supabase domains activate` to switch over.
