# 0002. CLI Product Metrics

**Status**: accepted
**Date**: 2026-02-10

## Problem Statement

Each team at Supabase is expected to track key metrics for their product to measure growth and adoption. The CLI serves both humans and LLM agents, but without defined metrics we can't answer basic questions: Is adoption growing? Are users successful? Which commands matter? Is the LLM audience real or theoretical?

## Decision

We define 5 metric categories with specific signals to track. All metrics are derived from opt-in anonymous telemetry (see [ADR 0001, Pillar 5](0001-cli-dx-architecture-pillars.md) for telemetry consent model).

### Adoption

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| **Monthly Active Users (MAU)** | Unique users who ran at least one command in the past 30 days | **North star metric** — single number for overall product health |
| New installs per week | First-time CLI executions | Growth rate |
| LLM vs human split | Ratio of non-TTY to TTY sessions | Validates the dual-audience thesis — are LLMs actually using it? |

### Engagement

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| Commands per session | Average commands between CLI start and idle timeout | One-and-done vs workflow usage |
| Command frequency distribution | Ranked usage count per command | Guides investment — unused commands are candidates for removal |
| Multi-command chains | Sessions with 3+ commands | Signal of deep usage, especially from LLM agents composing workflows |

### Retention

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| Week 1 retention | % of new users who return within 7 days | Early signal of product-market fit |
| Month 1 retention | % of new users who return within 30 days | Sustained value signal |
| Churn by command | Last command before a user stops returning | Identifies commands that drive users away |

### Quality

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| **Command success rate** | % of commands exiting 0 | **Quality guardrail** — growth doesn't matter if commands are failing |
| Error code distribution | Frequency of each error code | Prioritizes which errors to fix first |
| p50 / p95 command latency | Wall-clock time per command | Validates performance budgets from ADR 0001 in the real world |

### Onboarding

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| Time to first successful command | Duration from install to first exit code 0 | Measures onboarding friction |
| Drop-off funnel | install → first run → login → first meaningful command (`supa dev` or `supa link`) | Identifies where new users get stuck |

## Rationale

**MAU as north star**: it's simple, universally understood, and directly measures whether people are using the product. It avoids vanity metrics like "total installs" which count users who tried once and left.

**Command success rate as quality guardrail**: a CLI that errors frequently will lose users regardless of how fast adoption grows. Pairing MAU (growth) with success rate (quality) prevents optimizing one at the expense of the other.

**LLM vs human split**: this is unique to our CLI. If LLMs aren't using the non-TTY auto-JSON path, the investment in LLM-native design (Pillar 7) isn't paying off. If they are, it validates the architecture.

**Churn by command**: most retention analysis looks at users holistically. For a CLI, the granularity is at the command level — a user might love `supa dev` but churn after hitting `supa migrations push`. Command-level churn identifies specific pain points.

## Implementation

### Infrastructure

A single OpenTelemetry-based pipeline handles all concerns — product analytics, performance traces, and error diagnostics. The backend evolves in phases:

| Phase | Backend | Purpose | Status |
|---|---|---|---|
| **Phase 1** | **Sentry** (via `@sentry/bun`) | All 5 metric categories + error diagnostics + performance traces | Now |
| **Phase 2** | **Grafana** (company-owned) | Long-term analytics + custom observability dashboards | Future |

Both phases consume the same OTel spans with the same attributes. The CLI code does not change between phases — only the exporter configuration. ADR 0001 Pillar 5 and this ADR share infrastructure — one telemetry event schema, one write path, one consent model.

### Telemetry Event Schema

```typescript
type TelemetryEvent = {
  // Schema
  schema_version: 1;

  // Identity
  device_id: string;       // random UUID, persisted in ~/.supa/telemetry.json
  session_id: string;      // rotates on 30-min idle
  is_first_run: boolean;   // true on very first CLI execution
  user_id?: string;        // Supabase account UUID, present after `supa login`

  // Command
  command: string;         // e.g. "dev", "projects list"
  exit_code: number;       // 0 = success, 1-4 = error categories
  duration_ms: number;     // wall-clock time
  startup_ms: number;      // time to parse args and load handler
  error_code?: string;     // e.g. "AUTH_TOKEN_EXPIRED" (only on failure)

  // Environment
  is_tty: boolean;         // true = human, false = LLM/CI/pipe
  is_ci: boolean;          // true if running in known CI environment
  os: string;              // e.g. "darwin", "linux", "win32"
  arch: string;            // e.g. "arm64", "x64"
  cli_version: string;     // e.g. "0.1.0"

  // API activity
  api_request_count: number;
  api_request_duration_ms: number;
  api_request_errors: number;

  // Workflow spans (only for workflow commands, see ADR 0007)
  spans?: Array<{
    name: string;          // e.g. "docker.start", "config.load"
    duration_ms: number;
  }>;
};
```

One event per command completion. No PII. The `spans` field connects to ADR 0007's progress events — each `step`/`done` pair becomes a span.

### Consent Model

Three-state model: `"pending" | "granted" | "denied"`, stored in `~/.supa/telemetry.json`.

- Non-TTY defaults to `denied` without prompting (LLM agents and CI never see a prompt)
- `SUPA_TELEMETRY=off` env var overrides consent
- `supa telemetry enable/disable/status` commands for user control

## Consequences

### Positive

- Team has clear metrics to report on growth and adoption
- Product decisions are data-informed (which commands to invest in, which errors to fix)
- LLM audience impact is measurable, not assumed
- Onboarding funnel identifies concrete friction to remove
- Telemetry pipeline is shared with observability (ADR 0001 Pillar 5) — one system to build and maintain, not two

### Negative

- Metrics are only as good as telemetry opt-in rates — low opt-in skews data
- Requires building a telemetry pipeline and dashboard
- Risk of over-indexing on metrics at the expense of qualitative feedback

## Alternatives Considered

1. **Track only installs** — vanity metric, doesn't measure ongoing usage or success
2. **Track everything, decide later** — leads to data overload and no clear priorities
3. **No formal metrics, rely on GitHub issues** — reactive, biased toward vocal users, invisible to leadership

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture Pillars (Pillar 5: Observability, telemetry consent model)
- [ADR 0007](0007-realtime-progress-in-command-handlers.md): Real-time Progress — progress events map to telemetry spans

## See Also

- [Telemetry Implementation](../telemetry.md): Collection architecture, identity resolution, consent flow, local storage, remote export, and metric derivation
