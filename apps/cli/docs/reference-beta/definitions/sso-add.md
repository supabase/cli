---
id: sso-add
kind: command
category: Authentication
title: sso add
symbol: supabase sso add
summary: Add a new SSO identity provider
usage: supabase sso add [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --attribute-mapping-file
    location: flag
    type: string
    description: Path to a JSON file mapping SAML attributes to custom JWT claims.
  - name: --domains
    location: flag
    type: strings
    description: Email domains to associate with the identity provider, comma-separated or repeated.
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
  - name: --skip-url-validation
    location: flag
    type: boolean
    description: Skip local validation of the metadata URL, such as in CI where the identity provider is unreachable.
    default: false
  - name: --type
    location: flag
    type: "[ saml ]"
    required: true
    description: Type of identity provider, based on its protocol.
    allowed_values:
      - saml
    short: -t
examples:
  - id: basic-usage
    title: Add with Metadata URL
    lang: sh
    code: |-
      supabase sso add \
        --type saml \
        --metadata-url 'https://...' \
        --domains company.com \
        --remote=abcdefghijklmnopqrst
    response: |-
      Information about the added identity provider. You can use
      company.com as the domain name on the frontend side to initiate a SSO
      request to the identity provider.
  - id: with-xml
    title: Add with Metadata File
    lang: sh
    code: |-
      supabase sso add \
        --type saml \
        --metadata-file /path/to/metadata/file.xml \
        --domains company.com \
        --remote=abcdefghijklmnopqrst
    response: |-
      Information about the added identity provider. You can use
      company.com as the domain name on the frontend side to initiate a SSO
      request to the identity provider.
---

Connects a SAML 2.0 identity provider to your project. Provide its metadata with `--metadata-url` or `--metadata-file`.
