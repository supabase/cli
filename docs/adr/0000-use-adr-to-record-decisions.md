# 0000. Use ADR to Record Architectural Decisions

**Status**: accepted
**Date**: 2026-02-10

## Problem Statement

supa is a CLI serving as the primary entry point to the Supabase platform. Architectural decisions around developer experience, performance, testing, error handling, and observability are made frequently.

Without a formal process for recording these decisions:

- New team members don't understand the _why_ behind architectural choices
- Past decisions are repeatedly debated
- Rationale for trade-offs is lost to tribal knowledge
- Onboarding takes longer

## Decision

We will use Architecture Decision Records (ADRs) in MADR (Markdown Any Decision Records) format to document significant architectural decisions.

Each ADR captures:

1. The decision that was made
2. The context and problem it solves
3. Why this decision was chosen over alternatives
4. What trade-offs and consequences result

ADRs are stored in `docs/adr/NNNN-short-title.md` and are version-controlled in Git.

## Rationale

MADR is:

- **Lightweight** — 1-2 pages of markdown, not 50-page design documents
- **Searchable** — keeps decisions accessible to future developers
- **Explicit about trade-offs** — forces clear thinking about consequences
- **Standardized** — used by GitHub, Spotify, and the ADR community
- **Evolvable** — decisions can be marked as deprecated or superseded

For a CLI where both humans and LLM agents invoke commands, architectural decisions impact output format stability, performance perception, error recovery, and testing strategy. Recording these decisions prevents regression and makes future decisions easier.

## Consequences

### Positive

- New developers understand the reasoning behind architectural patterns
- Prevents re-debating settled decisions
- Makes trade-offs explicit and reviewable
- Provides onboarding documentation
- Creates a decision trail for future maintenance

### Negative

- Requires discipline to write ADRs when making decisions
- ADRs can become outdated if not maintained
- Not all decisions warrant an ADR (judgment required)

## Alternatives Considered

1. **Wiki or Confluence** — less version-controlled, harder to track changes, not searchable in Git
2. **GitHub Issues/Discussions** — great for debate, but not designed for archival of final decisions
3. **Code comments** — scattered and hard to reference; not centralized
4. **No documentation** — causes context loss and repeated debates

## Criteria for an ADR

Create an ADR for decisions that:

- Affect multiple parts of the codebase
- Have significant trade-offs
- Impact testing, performance, or error handling
- Are architectural (not tactical)
- Will be relevant for future maintainers

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture Pillars
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics
- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI & Documentation Strategy

## See Also

- [MADR specification](https://adr.github.io/madr/)
- [ADR GitHub organization](https://adr.github.io/)
