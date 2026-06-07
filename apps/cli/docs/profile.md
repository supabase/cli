# Advanced Platform Configuration

This document captures the intended design for advanced non-default backend routing in the new
CLI.

The file is intentionally named `profile.md` to preserve continuity with the earlier discussion
and the old Go CLI concept. The design in this document does **not** recommend carrying the old
`profile` abstraction forward. The preferred term in the new CLI is **platform**.

## Overview

Most CLI users should implicitly target Supabase production without needing to learn any extra
concepts or configure any additional state.

A much smaller group of users needs to point the CLI somewhere else:

- Supabase developers working against staging
- advanced customer teams pointing at their own platform
- CI or debugging workflows that temporarily need alternate endpoints

The goal is to support those cases cleanly without turning non-default backend routing into a
first-class everyday feature.

## Why Not Go-Style Profiles

The old Go CLI `profile` abstraction became too broad.

It started as a way to switch API endpoints, but it ended up bundling multiple unrelated concerns:

- Management API routing
- dashboard URL selection
- project hostname derivation
- pooler hostname validation
- auth token scoping
- product-specific behavior
- project-region policy

That made `profile` convenient in the short term but leaky as an architecture. A single switch
silently affected networking, auth, validation, and product behavior at once.

The new CLI should not revive that abstraction. Routing to a different backend is a real need, but
it should be modeled narrowly and explicitly.

## Terminology

The preferred term is **platform**.

In this design, **platform** means:

- which backend and endpoint set the CLI talks to

This term should stay separate from other existing concepts:

- **target** means `local` vs `remote`
- **workspace link** means repo-local linked project/branch metadata
- **session** means stored authentication state

These concerns are related, but they are not the same thing and should not be collapsed into one
shared abstraction.

## UX Principles

The UX should follow these rules:

- Supabase production is the implicit default.
- Most users should never need to learn about platforms.
- Non-default platforms are a power-user and internal escape hatch.
- The CLI should not ship a public catalog of built-in staging or customer platforms.
- `login` should not implicitly mutate global platform state as a side effect.

This keeps the common path simple while still leaving room for advanced routing when needed.

## Configuration Model

Advanced named platforms should live in `SUPABASE_HOME`.

The format should be JSON, not TOML.

The model should support:

- multiple named platform entries
- one default selected named platform
- direct endpoint environment overrides for one-off use and CI

Recommended resolution order:

1. Explicit endpoint environment overrides
2. Named platform selected by env var, if present
3. Default named platform from `SUPABASE_HOME`
4. Built-in Supabase production defaults

This gives advanced users persistent configuration without making non-default state part of the
everyday CLI surface.

## Config Shape

The exact filename under `SUPABASE_HOME` is still open, but the structure should look like this:

```json
{
  "platform": {
    "default": "staging"
  },
  "platforms": {
    "staging": {
      "api_url": "https://api.supabase.green",
      "dashboard_url": "https://supabase.green/dashboard",
      "project_host": "supabase.red",
      "pooler_host": "supabase.green"
    },
    "customer_acme": {
      "api_url": "https://api.acme.example",
      "dashboard_url": "https://console.acme.example",
      "project_host": "acme.example",
      "pooler_host": "acme.example"
    }
  }
}
```

Each platform entry should support:

- `api_url`
- `dashboard_url`
- `project_host`
- `pooler_host` optional

Validation rules should be strict:

- keys are fixed and explicit
- URLs must be absolute URLs
- hosts must be hostnames, not URLs
- unknown keys fail fast
- missing named platforms fail with a targeted error

This should be treated as advanced configuration, not a loose bag of arbitrary overrides.

## Auth Scoping

Stored auth should be partitioned by **resolved platform identity**, not by local alias name.

That means the auth namespace should be derived from the fully resolved platform endpoint set, not
just from a user-chosen label like `staging` or `customer_acme`.

Why this matters:

- prod and staging tokens must never bleed into each other
- custom-platform tokens must stay isolated from Supabase production
- alias renames should not unexpectedly orphan or duplicate auth state

It is acceptable for two aliases that resolve to the same platform identity to intentionally share
auth.

## Architecture Boundaries

The routing model should fit into the new CLI architecture like this:

- `CliConfig` resolves the effective platform endpoints
- auth consumes a resolved platform identity
- workspace link remains separate from platform selection
- target selection remains `local` vs `remote`

Product-specific behavior should not be hidden inside platform routing.

If a future product or partner integration needs special behavior, that should be modeled
explicitly through its own capability or plugin boundary, not as an incidental side effect of
choosing a platform entry.

## Important Interfaces

The advanced config surface this design assumes:

- `SUPABASE_API_URL`
- `SUPABASE_DASHBOARD_URL`
- `SUPABASE_PROJECT_HOST`
- `SUPABASE_POOLER_HOST`
- optional named selector env var, likely `SUPABASE_PLATFORM`
- `SUPABASE_HOME` as the storage root for advanced global platform config

Platform entry fields:

- `api_url`
- `dashboard_url`
- `project_host`
- `pooler_host`

These are advanced interfaces. They should be stable and deliberate, but they should not dominate
the main user-facing CLI experience.

## Non-Goals

This design does not propose:

- a public `supabase platform ...` command group
- a built-in first-party staging alias in the public UX
- customer-specific platform definitions baked into the CLI
- plugin or product behavior encoded directly inside platform config
- backward compatibility with Go CLI `profile` names or storage behavior

## Open Follow-up Work

- Decide the final JSON filename and exact location under `SUPABASE_HOME`
- Decide whether `SUPABASE_PLATFORM` should exist as the named-platform selector env var
- Update auth design docs to scope stored auth by resolved platform identity
- Update config docs once implementation starts
- Decide later whether a low-visibility internal or admin command is needed for inspecting or
  debugging resolved platform state

## Summary

The new CLI should keep the old filename `profile.md` for continuity, but the actual design should
move away from the old `profile` abstraction.

The right model is:

- production-by-default UX
- `platform` as the advanced routing concept
- JSON config in `SUPABASE_HOME`
- strict validation
- env var overrides for CI and one-off use
- auth scoped by resolved platform identity

This preserves a simple default experience while giving advanced users a clear and well-bounded way
to point the CLI at a different platform.
