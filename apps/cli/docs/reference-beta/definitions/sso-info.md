---
id: sso-info
kind: command
category: Authentication
title: sso info
symbol: supabase sso info
summary: Returns the SAML SSO settings required for the identity provider
usage: supabase sso info [flags]
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
  - id: basic-usage
    title: Show project information
    lang: sh
    code: supabase sso info --remote=abcdefghijklmnopqrst
    response: Information about your project's SAML 2.0 configuration.
---

Shows the values your identity provider needs to register your project, such as the ACS URL and the SP Entity ID.
