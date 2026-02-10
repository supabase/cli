# Architecture Decision Records (ADRs)

We record architecture decisions for the supa CLI using the MADR (Markdown Any Decision Records) format.

## What is an ADR?

An Architecture Decision Record (ADR) captures important architectural decisions along with their context and consequences.

Each ADR describes:

- **What decision was made** — the technical choice
- **Why it was made** — the problem and rationale
- **What trade-offs were accepted** — the consequences
- **What alternatives were considered** — why others didn't work

ADRs are concise (1-2 pages), version-controlled in Git, and used for onboarding and decision continuity.

## Why we use ADRs

For a CLI serving as the entry point to Supabase, architectural decisions affect developer experience, performance, testing strategy, observability, and error handling — for both human and LLM consumers. Recording these decisions prevents repeated debates and makes trade-offs explicit.

## File naming and status

**Naming convention**: `NNNN-short-title.md`

**Status lifecycle**:

```
proposed → accepted → deprecated / superseded by [NNNN]
```

## How to create a new ADR

1. Assign the next number (e.g., `0002-*`)
2. Use the MADR template below
3. Set status to `proposed`
4. Open a PR for team review
5. Update status to `accepted` once consensus is reached

When an ADR becomes outdated, mark it as `deprecated` or reference the superseding ADR.

## ADR index

| ID   | Title                                                                                    | Status   |
| ---- | ---------------------------------------------------------------------------------------- | -------- |
| 0000 | [Use ADR to Record Decisions](0000-use-adr-to-record-decisions.md)                       | accepted |
| 0001 | [CLI DX Architecture: The 7 Pillars](0001-cli-dx-architecture-pillars.md)                | accepted |
| 0002 | [CLI Product Metrics](0002-cli-product-metrics.md)                                       | accepted |
| 0003 | [Self-Documenting CLI & Documentation Strategy](0003-self-documenting-cli.md)            | accepted |
| 0004 | [CLI Design Goals & Development Workflows](0004-cli-design-goals-and-workflows.md)       | accepted |
| 0005 | [OpenAPI-Driven Code Generation for CRUD Commands](0005-openapi-driven-code-generation.md) | proposed |
| 0006 | [Environment Management & Variable Resolution](0006-environment-management.md)           | proposed |
| 0007 | [Real-time Progress in Command Handlers](0007-realtime-progress-in-command-handlers.md)  | proposed |
| 0008 | [Authentication & Token Management](0008-authentication-and-token-management.md)        | proposed |
| 0009 | [Configuration Schema & Validation](0009-configuration-schema-and-validation.md)         | proposed |
| 0010 | [Process Manager Architecture](0010-process-manager-architecture.md)                     | proposed |

## Template

```markdown
# NNNN. Title

**Status**: proposed
**Date**: YYYY-MM-DD

## Problem Statement

What problem are we trying to solve? Provide context about why this decision matters.

## Decision

What is the decision? State it clearly and concisely.

## Rationale

Why did we choose this approach?

## Consequences

### Positive

- Benefit 1

### Negative

- Trade-off 1

## Alternatives Considered

1. **Alternative A**: Why we didn't choose this

## Related Decisions

- ADR NNNN: Related decision

## See Also

- External link or reference
```

> **Note**: Additional sections (Implementation Notes, Open Questions, Verification Checklist) may be added as needed.
