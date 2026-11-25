---
id: sso-update
kind: command
category: Authentication
title: sso update
symbol: supabase sso update
summary: Update information about an SSO identity provider
usage: supabase sso update <provider-id> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: provider-id
    location: positional
    required: true
  - name: --add-domains
    location: flag
    type: strings
    description: Email domains to add to the identity provider, comma-separated or repeated.
    variadic: true
  - name: --attribute-mapping-file
    location: flag
    type: string
    description: Path to a JSON file mapping SAML attributes to custom JWT claims.
  - name: --domains
    location: flag
    type: strings
    description: Email domains that replace the current list, comma-separated or repeated.
    variadic: true
  - name: --metadata-file
    location: flag
    type: string
    description: Path to a SAML 2.0 Metadata XML file describing the identity provider.
  - name: --metadata-url
    location: flag
    type: string
    description: URL of a SAML 2.0 Metadata XML document describing the identity provider.
  - name: --name-id-format
    location: flag
    type: string
    description: SAML name ID format URI used to identify users.
    allowed_values:
      - urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
      - urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified
      - urn:oasis:names:tc:SAML:2.0:nameid-format:persistent
      - urn:oasis:names:tc:SAML:2.0:nameid-format:transient
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --remove-domains
    location: flag
    type: strings
    description: Email domains to remove from the identity provider, comma-separated or repeated.
    variadic: true
  - name: --skip-url-validation
    location: flag
    type: boolean
    description: Skip local validation of the metadata URL, such as in CI where the identity provider is unreachable.
    default: false
examples:
  - id: basic-usage
    title: Replace domains
    lang: sh
    code: |-
      supabase sso update 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --domains new-company.com,new-company.net \
        --remote=abcdefghijklmnopqrst
    response: Information about the updated provider.
  - id: add-domains
    title: Add an additional domain
    lang: sh
    code: |-
      supabase sso update 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --add-domains company.net \
        --remote=abcdefghijklmnopqrst
    response: Information about the updated provider.
  - id: remove-domains
    title: Remove a domain
    lang: sh
    code: |-
      supabase sso update 6df4d73f-bf21-405f-a084-b11adf19fea5 \
        --remove-domains company.org \
        --remote=abcdefghijklmnopqrst
    response: Information about the updated provider.
---

Changes the email domains, metadata, attribute mapping or name ID format of a connected identity provider.
