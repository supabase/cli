---
id: gen-signing-key
kind: command
category: generate-types
subcategory: gen
title: gen signing-key
symbol: supabase gen signing-key
summary: Generate a JWT signing key
usage: supabase gen signing-key [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --algorithm
    location: flag
    type: "[ ES256 | RS256 ]"
    description: Algorithm to generate the signing key with.
    default: ES256
    allowed_values:
      - ES256
      - RS256
  - name: --append
    location: flag
    type: boolean
    description: Append the new key to the existing keys file instead of overwriting it.
    default: false
examples:
  - id: example-1
    title: Generate an ES256 signing key and print it to stdout
    lang: sh
    code: supabase gen signing-key
  - id: example-2
    title: Generate an RSA signing key
    lang: sh
    code: supabase gen signing-key --algorithm RS256
  - id: example-3
    title: Append a new key to the configured signing key file
    lang: sh
    code: supabase gen signing-key --append
---

Generate a private JWT signing key to use in the CLI or to import in the dashboard.

Supported algorithms:
  ES256 - ECDSA with P-256 curve and SHA-256 (recommended)
  RS256 - RSA with SHA-256
