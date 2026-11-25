---
id: domains-reverify
kind: command
category: custom-domains
subcategory: domains
title: domains reverify
symbol: supabase domains reverify
summary: Re-verify the custom hostname config
usage: supabase domains reverify [flags]
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
    title: Re-verify the custom hostname for a project
    lang: sh
    code: supabase domains reverify --remote=abcdefghijklmnopqrst
---

Asks Supabase to check your DNS records again. Run it after you add or change the CNAME or TXT records for your hostname.
