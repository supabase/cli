---
id: sso-update
kind: command
category: sso
title: sso update
symbol: supabase sso update
summary: Update information about an SSO identity provider
usage: supabase sso update <provider-id> [flags]
description: Update the configuration settings of a already added SSO identity provider.
parameters:
  - name: provider-id
    location: positional
    required: true
  - name: --add-domains
    location: flag
    type: strings
    description: Add this comma separated list of email domains to the identity provider.
    default: "[]"
  - name: --attribute-mapping-file
    location: flag
    type: string
    description: File containing a JSON mapping between SAML attributes to custom JWT claims.
    default: ""
  - name: --domains
    location: flag
    type: strings
    description: Replace domains with this comma separated list of email domains.
    default: "[]"
  - name: --metadata-file
    location: flag
    type: string
    description: File containing a SAML 2.0 Metadata XML document describing the identity provider.
    default: ""
  - name: --metadata-url
    location: flag
    type: string
    description: URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.
    default: ""
  - name: --name-id-format
    location: flag
    type: string
    description: URI reference representing the classification of string-based identifier information.
    default: ""
    allowed_values:
      - urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
      - urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified
      - urn:oasis:names:tc:SAML:2.0:nameid-format:persistent
      - urn:oasis:names:tc:SAML:2.0:nameid-format:transient
  - name: --remote
    location: flag
    type: ref|branch
    description: "Target another project: `--remote=<ref|branch>`. Defaults to the linked project."
    default: "false"
  - name: --remove-domains
    location: flag
    type: strings
    description: Remove this comma separated list of email domains from the identity provider.
    default: "[]"
  - name: --skip-url-validation
    location: flag
    type: boolean
    description: Skip local validation of the SAML 2.0 Metadata URL (HTTPS requirement, live GET probe, and UTF-8 body decode). Use in air-gapped CI where the IDP is not reachable from the build agent.
    default: "false"
  - name: --agent
    location: flag
    type: "[ auto | yes | no ]"
    description: "Override agent detection: yes, no, or auto"
    default: auto
    allowed_values:
      - auto
      - "yes"
      - "no"
  - name: --debug
    location: flag
    type: boolean
    description: output debug logs to stderr
    default: "false"
  - name: --dns-resolver
    location: flag
    type: "[ native | https ]"
    description: lookup domain names using the specified resolver
    default: native
    allowed_values:
      - native
      - https
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
  - name: --help
    location: flag
    type: boolean
    description: Show help information
    short: -h
    default: "false"
  - name: --network-id
    location: flag
    type: string
    description: use the specified docker network instead of a generated one
    default: ""
  - name: --output
    location: flag
    type: "[ env | pretty | json | toml | yaml ]"
    description: output format of status variables
    short: -o
    default: pretty
    allowed_values:
      - env
      - pretty
      - json
      - toml
      - yaml
  - name: --output-format
    location: flag
    type: "[ text | json | stream-json ]"
    description: "Output format: text, json, or stream-json (NDJSON)"
    default: text
    allowed_values:
      - text
      - json
      - stream-json
  - name: --profile
    location: flag
    type: string
    description: use a specific profile for connecting to Supabase API
    default: supabase
  - name: --workdir
    location: flag
    type: string
    description: path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)
    default: ""
  - name: --yes
    location: flag
    type: boolean
    description: answer yes to all prompts; hosted changes only accept this flag or SUPABASE_YES exported in your shell, never supabase/.env or another .env file
    default: "false"
inherits_flags: global-flags
examples:
  - id: example-1
    title: Update an SSO provider's domains
    lang: sh
    code: supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --add-domains example.com --remote=mwjylndxudmiehsxhmmz
---
