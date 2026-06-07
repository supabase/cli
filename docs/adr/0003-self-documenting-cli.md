# 0003. Self-Documenting CLI & Documentation Strategy

**Status**: accepted
**Date**: 2026-02-10

## Problem Statement

The CLI already captures rich, structured metadata in code:

1. **Stricli command definitions** — `docs.brief`, flag descriptions, positional argument descriptions, examples
2. **Config schema** — `description`, `tags`, `links`, `examples` on every field
3. **Error codes** — typed union of machine-stable codes with messages and suggestions

This metadata powers `--help` output at runtime. But reference documentation (command pages, config reference, error troubleshooting) is typically maintained separately — in a wiki, a docs repo, or hand-written markdown. Separate docs inevitably drift from the code: flags get added without updating the docs, error codes change without updating the troubleshooting guide, config fields are deprecated but the docs still reference them.

We need a documentation strategy that eliminates this drift.

## Decision

**Code is the single source of truth for reference documentation.** The `--help` output and the docs website are two views of the same data.

### Three Documentation Sources (from code)

| Source | What it generates |
|--------|------------------|
| Stricli command definitions (`docs.brief`, flags, args, examples) | Command reference pages |
| Config schema (descriptions, tags, links, examples) | Configuration reference |
| Error code types (code + message + suggestion) | Error reference with troubleshooting |

A build step introspects these sources and outputs structured content (markdown or JSON) that a static site generator consumes.

### Hand-Written Content (markdown)

Not everything can be generated from code. Guides, tutorials, and narrative content are hand-written and live in `docs/`:

- **Guides and tutorials** — getting started, workflows, migration paths
- **Examples** — common recipes, LLM integration patterns
- **ADRs** — architecture decision records (this directory)

Hand-written content is versioned alongside the code in the same repository.

### Generation Pipeline

```
┌──────────────────────────────────────────────┐
│              CLI Source Code                   │
│                                               │
│  Stricli commands    Config schema      Error  │
│  (flags, args,       (descriptions,    codes   │
│   docs, examples)     tags, links)     (typed) │
└──────┬───────────────────┬──────────────┬─────┘
       │                   │              │
       ▼                   ▼              ▼
┌──────────────────────────────────────────────┐
│           Generation Build Step               │
│  Introspects command tree, config schema,     │
│  and error types → outputs markdown or JSON   │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│           Static Site Generator               │
│  Consumes generated reference content         │
│  alongside hand-written guides and ADRs       │
└──────────────────────────────────────────────┘
```

The generation step runs at build time (not runtime). The specific static site generator is an implementation detail — the architecture works with any tool that can consume markdown or JSON.

### What's Generated vs What's Hand-Written

| Content type | Source | Why |
|-------------|--------|-----|
| Command reference (flags, args, usage) | Generated from Stricli definitions | Changes every time a flag is added/removed |
| Config reference (fields, types, defaults) | Generated from config schema | Changes every time a config field changes |
| Error reference (codes, messages, suggestions) | Generated from error types | Changes every time an error is added/modified |
| Guides and tutorials | Hand-written markdown | Narrative, opinionated, requires human judgment |
| Examples and recipes | Hand-written markdown | Context-dependent, curated |
| ADRs | Hand-written markdown | Architectural decisions require human reasoning |

The boundary is clear: **reference = generated, narrative = manual**.

## Rationale

### Why code-as-source-of-truth

- **Eliminates drift** — generated docs are always in sync with the code because they *are* the code
- **Single maintenance point** — update a flag description once (in the Stricli definition), both `--help` and the docs website reflect it
- **Enforces quality** — if a command has no description, it's visible in both `--help` and the docs, creating pressure to fix it
- **Reviewable in PRs** — doc changes are code changes, reviewed by the same people who review the code

### Why not a wiki or separate docs repo

- **Goes stale** — wikis are updated by a different person at a different time, if at all
- **Disconnected from releases** — a wiki can't be versioned with the code; docs for v2 might still describe v1 behavior
- **No CI enforcement** — a wiki can't be linted, type-checked, or tested
- **Split ownership** — the person who adds a flag isn't the person who updates the wiki

### Why docs are versioned with the code

The docs site publishes from the same repo and branch as the CLI. This means:

- A PR that adds a new flag also updates the docs (automatically, via generation)
- A release branch produces docs that match that release
- Docs can be previewed in PR builds

## Consequences

### Positive

- Reference documentation is always accurate — it cannot drift from the implementation
- Adding a new command, flag, config field, or error code automatically updates the docs
- `--help` and the docs website are guaranteed consistent
- PRs that change CLI behavior automatically include doc changes
- No separate "update the docs" step in the release process

### Negative

- Requires building and maintaining the generation pipeline
- Generated content may need post-processing for readability (e.g., ordering, grouping)
- Hand-written content still requires manual maintenance
- The generation step adds to CI build time

## Alternatives Considered

1. **Hand-written docs only** — the traditional approach. Docs drift from code within weeks. Every flag change requires updating two places. Inevitably goes stale.
2. **Separate docs repository** — disconnected from the code lifecycle. Can't be versioned with releases. Different reviewers, different cadence, different quality bar.
3. **Wiki (Notion, Confluence, GitHub Wiki)** — not version-controlled, not reviewable in PRs, not CI-enforceable. Goes stale faster than a separate repo.
4. **README-driven development** — READMEs are hand-written and drift. They also don't scale beyond a single page of content.

## Related Decisions

- [ADR 0000](0000-use-adr-to-record-decisions.md): Use ADR to Record Decisions
- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture Pillars (Pillar 7: discoverable `--help`, Pillar 4: error codes)
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics
