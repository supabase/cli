---
id: sso-list
kind: command
category: Authentication
title: sso list
symbol: supabase sso list
summary: List all SSO identity providers
usage: supabase sso list [flags]
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
    title: List all SSO providers for a project
    lang: sh
    code: supabase sso list --remote=mwjylndxudmiehsxhmmz
---

Shows the identity providers connected to your project, with their IDs and email domains.
