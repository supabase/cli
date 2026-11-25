---
id: gen-bearer-jwt
kind: command
category: generate-types
subcategory: gen
title: gen bearer-jwt
symbol: supabase gen bearer-jwt
summary: Generate a Bearer Auth JWT for the Data API
usage: supabase gen bearer-jwt [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --exp
    location: flag
    type: string
    description: Expiry timestamp of the token.
  - name: --payload
    location: flag
    type: string
    description: Custom claims to add, as a JSON object.
    default: "{}"
  - name: --role
    location: flag
    type: string
    required: true
    description: Postgres role the token acts as.
  - name: --sub
    location: flag
    type: string
    description: User ID to impersonate, set as the `sub` claim.
    default: anonymous
  - name: --valid-for
    location: flag
    type: string
    description: How long the token stays valid, such as `30m`.
    default: 30m0s
examples:
  - id: example-1
    title: Generate a token for an authenticated user
    lang: sh
    code: supabase gen bearer-jwt --role authenticated --sub <user-id>
  - id: example-2
    title: Generate a service role token valid for one hour
    lang: sh
    code: supabase gen bearer-jwt --role service_role --valid-for 1h
---

Create a signed JWT for a Postgres role, for calling the Data API. The token is signed locally with a JWT signing key.

Set the claims with `--sub` and `--payload`, and the lifetime with `--valid-for` or `--exp`.
