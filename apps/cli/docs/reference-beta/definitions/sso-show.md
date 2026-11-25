---
id: sso-show
kind: command
category: authentication
subcategory: sso
title: sso show
symbol: supabase sso show
summary: Show information about an SSO identity provider
usage: supabase sso show <provider-id> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: provider-id
    location: positional
    required: true
  - name: --metadata
    location: flag
    type: boolean
    description: Print only the SAML 2.0 Metadata XML.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: basic-usage
    title: Show information
    lang: sh
    code: |-
      supabase sso show 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --remote=abcdefghijklmnopqrst
    response: Information about the identity provider in pretty output.
  - id: metadata-output
    title: Get raw SAML 2.0 Metadata XML
    lang: sh
    code: |-
      supabase sso show 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --metadata \
        --remote=abcdefghijklmnopqrst
    response: |-
      Raw SAML 2.0 XML assigned to this identity provider. This is the
      version used in the authentication project, and if using a SAML 2.0
      Metadata URL it may change depending on the caching information
      contained within the metadata.
---

Shows the settings of a connected identity provider. Use `--metadata` to print the raw SAML 2.0 Metadata XML stored in your project instead.
