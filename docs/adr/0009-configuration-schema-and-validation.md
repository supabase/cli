# 0009. Configuration Schema & Validation

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

`config.json` is referenced in ADRs 0003 (doc generation from schema), 0004 (project manifest), 0006 (`env()` syntax, `environments` block, branch mapping), and PLAN.md shows a `@supabase/config` package. No ADR captures the schema design decisions.

## Key Decisions to Cover

- **Schema format**: JSON Schema-based (per PLAN.md), but what generates the schema? Zod? TypeBox? Hand-written?
- **`env()` syntax**: How it works, how it's parsed, error handling for missing vars
- **Schema versioning**: How to handle schema evolution, what happens when a user's config is from an older schema version
- **Validation**: When does it run (on load? on push?), error messages, partial validation
- **Platform variables vs user variables**: Implicit binding from config paths (ADR 0006 Section 6) vs explicit `env()`
- **Default config generation**: What `supabase init` produces
- **Migration**: From old `supabase/config.toml` to new `supabase/config.json`
- **`@supabase/config` package architecture**: How it exports schema, types, and template (from PLAN.md)

## Related Decisions

- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI — doc generation from config schema
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals — config as project manifest
- [ADR 0006](0006-environment-management.md): Environment Management — `env()` syntax, `environments` block
