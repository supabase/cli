---
id: sso-remove
kind: command
category: authentication
subcategory: sso
title: sso remove
symbol: supabase sso remove
summary: Remove an existing SSO identity provider
usage: supabase sso remove <provider-id> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: provider-id
    location: positional
    required: true
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: basic-usage
    title: Remove a provider
    lang: sh
    code: |-
      supabase sso remove 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --remote=abcdefghijklmnopqrst
    response: |-
      Information about the removed identity provider. It's a good idea to
      save this in case you need it later on.
---

Disconnects an identity provider from your project. Existing users of that provider can no longer sign in, so use it with care.
