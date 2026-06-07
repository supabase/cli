# Telemetry Implementation

> Extracted from [ADR 0002](adr/0002-cli-product-metrics.md). This document covers the implementation details of the CLI telemetry system. For the metric categories, event schema contract, and architectural decisions, see the ADR.

## Unified Infrastructure

ADR 0001 Pillar 5 and ADR 0002 share infrastructure. No separate metrics SDK and tracing SDK — one telemetry event schema, one write path, one consent model. A single OpenTelemetry-based pipeline handles all concerns, with the backend evolving in phases:

| Phase | Backend | Purpose | Status |
|---|---|---|---|
| **Phase 1** | **Sentry** (via `@sentry/bun`) | All 5 metric categories + error diagnostics + performance traces | Now |
| **Phase 2** | **Grafana** (company-owned) | Long-term analytics + custom observability dashboards | Future |

```
┌─────────────────────────────────────────────┐
│              Command Execution               │
│                                              │
│  handler logic → withTelemetry() middleware  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  OTel Span(s)   │
          │ (single schema) │
          └────────┬────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
Local file      --debug       Remote
~/.supabase/        output        export
traces/         (always)      (opt-in)
(always)           │               │
     │             │         ┌─────┴─────┐
     ▼             ▼         ▼           ▼
Observability  Observability Sentry    Grafana
(ADR 0001      (ADR 0001    (Phase 1) (Phase 2,
 Pillar 5)      Pillar 5)             future)
```

Sentry receives every command span via its native OpenTelemetry integration and powers error diagnostics, performance monitoring, and product analytics dashboards for all 5 metric categories from ADR 0002. In Phase 2, spans will also be exported to a company-owned Grafana instance via OTLP for long-term retention and custom analytics. The CLI code does not change between phases — only the exporter configuration.

## Collection Architecture

`withTelemetry()` middleware wrapping Stricli command handlers. The middleware:

- Records `startup_ms` (time from process start to handler entry)
- Creates a root OTel span for the command invocation
- Runs the handler
- Records `duration_ms`, `exit_code`, `error_code` as span attributes
- Collects API stats from an injected API client
- Sets span status and ends the span
- Handlers never interact with telemetry directly

Pattern:

```typescript
function withTelemetry<T>(handler: CommandHandler<T>): CommandHandler<T> {
  return async (flags) => {
    const tracer = trace.getTracer("supabase-cli");
    return tracer.startActiveSpan(`cli.command.${flags.__command}`, async (span) => {
      const start = performance.now();
      span.setAttributes({
        "cli.command": flags.__command,
        "cli.startup_ms": start - globalThis.__processStart,
        "cli.device_id": getDeviceId(),
        "cli.session_id": getSessionId(),
        "cli.is_first_run": isFirstRun(),
        "cli.is_tty": process.stdout.isTTY ?? false,
        "cli.is_ci": Boolean(process.env.CI),
        "cli.version": CLI_VERSION,
        "os.type": process.platform,
        "host.arch": process.arch,
      });

      const result = await handler(flags);

      const exitCode = result.ok ? 0 : exitCodeFromError(result.error);
      span.setAttributes({
        "cli.exit_code": exitCode,
        "cli.duration_ms": performance.now() - start,
        "cli.api_request_count": apiClient.requestCount,
        "cli.api_request_duration_ms": apiClient.requestDurationMs,
        "cli.api_request_errors": apiClient.requestErrors,
      });

      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
        span.setAttribute("cli.error_code", result.error.code);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
      return result;
    });
  };
}
```

Integration with Stricli's lazy imports:

```typescript
command({
  func: async (flags) => {
    const { runDev } = await import("./dev.handler");
    return withTelemetry(runDev)(flags);
  },
});
```

## Identity

**Anonymous phase** — before login:

`device_id`: random UUID generated on first run, persisted in `~/.supabase/telemetry.json`. Never changes unless the file is deleted. This is the only identity before the user runs `supabase login`. It is attached to every span as the `cli.device_id` resource attribute.

`session_id`: random UUID that rotates after 30 minutes of inactivity (no CLI commands). This defines "session" for the Engagement metrics.

`is_first_run`: true only on the very first CLI execution ever (when `telemetry.json` doesn't exist yet). Powers the Onboarding metrics.

Note: `user_id` (Supabase account UUID) is a future enhancement, pending a profile endpoint that returns the account UUID from the auth token. When available, it will be attached as `cli.user_id` resource attribute and will enable cross-device identity linking.

**OTel resource attributes**:

```typescript
// Resource attributes set once at SDK initialization
const resource = new Resource({
  "service.name": "supabase-cli",
  "service.version": CLI_VERSION,
  "cli.device_id": getDeviceId(),   // always present, never rotates
  "os.type": process.platform,
  "host.arch": process.arch,
});
```

**Identity lifecycle**:

```
┌─────────────────────────────────┐
│           Anonymous              │
│                                  │
│  cli.device_id ✓ (always set)   │
│  cli.user_id   ✗ (future)       │
└─────────────────────────────────┘
```

Privacy guarantees:

| What we track | What we never track |
|---|---|
| Random device UUID | IP address, username, hostname |
| Command name and exit code | Command arguments or flag values |
| Timing and error codes | File paths, SQL content, project names |
| OS and architecture | Environment variables |
| Stack traces (via span.recordException()) | Email, name, or other profile data |

## Local Storage

NDJSON files in `~/.supabase/traces/`:

- One file per day: `2025-01-15.ndjson`
- 7-day automatic retention (older files deleted on CLI startup)
- Always written regardless of consent — this is the user's own machine
- Powers `--debug` output and local diagnostics (ADR 0001 Pillar 5)
- Same span attribute format as remote export

## Remote Export

Single pipeline, one consent gate, phased backends:

### Phase 1: Sentry (now)

- Uses `@sentry/bun` SDK which has native OpenTelemetry integration — no separate `@opentelemetry/exporter-trace-otlp-http` needed
- Sentry SDK is lazy-loaded (only imported when consent is granted)
- PII filtering via Sentry's `beforeSendTransaction` / `beforeSend` hooks — strips file paths, environment variables, and usernames before data leaves the CLI
- Error spans → Sentry Issues; performance spans → Sentry Performance; custom span attributes → Sentry tags
- Error spans include stack traces and error context for debugging and alerting

```typescript
// Phase 1: Sentry — initialized once when consent is granted
import * as Sentry from "@sentry/bun";

Sentry.init({
  dsn: SENTRY_DSN,
  release: `supabase-cli@${CLI_VERSION}`,
  tracesSampleRate: 1.0,
  beforeSendTransaction(event) {
    return stripPii(event);
  },
  beforeSend(event) {
    return stripPii(event);
  },
});
```

### Phase 2: Grafana (future)

- Add `@opentelemetry/exporter-trace-otlp-http` alongside Sentry
- Both exporters receive the same spans via a composite span processor
- Sentry continues for real-time alerting and error triage; Grafana provides long-term retention and custom dashboards
- The CLI code does not change — only the exporter configuration

### Shared behavior

- Does not send data unless consent is `granted`
- Does not block command execution
- Lazy-loaded to avoid startup cost when consent is `denied`

Performance: total overhead < 1ms per command (span construction + non-blocking SDK calls).

### End-to-end example: `supabase projects list`

**Success path** — user runs `supabase projects list` and gets a list of projects:

```typescript
// 1. withTelemetry() creates a root span
const span = tracer.startSpan("cli.command.projects list");
const start = performance.now(); // 45ms after process start

// 2. Set attributes at span start
span.setAttributes({
  "cli.command": "projects list",
  "cli.startup_ms": 45,
  "cli.device_id": "a1b2c3d4-...",
  "cli.session_id": "e5f6g7h8-...",
  "cli.is_first_run": false,
  "cli.is_tty": true,
  "cli.is_ci": false,
  "cli.version": "0.1.0",
  "os.type": "darwin",
  "host.arch": "arm64",
});

// 3. Handler runs
const result = await listProjects(flags); // { ok: true, data: [...] }

// 4. Set outcome attributes and end span
span.setAttributes({
  "cli.exit_code": 0,
  "cli.duration_ms": 234,
  "cli.api_request_count": 1,
  "cli.api_request_duration_ms": 189,
  "cli.api_request_errors": 0,
});
span.setStatus({ code: SpanStatusCode.OK });
span.end();

// 5. Always: append to local trace file
// ~/.supabase/traces/2025-01-15.ndjson += JSON.stringify(spanData) + "\n"

// 6. If consent === "granted": Sentry SDK exports the span
// Non-blocking — SDK batches internally
```

**Error path** — user runs `supabase projects list` but their token has expired:

```typescript
// 1. withTelemetry() creates a root span (same as success)
const span = tracer.startSpan("cli.command.projects list");

// 2. Set initial attributes (same as success)
span.setAttributes({
  "cli.command": "projects list",
  "cli.startup_ms": 45,
  // ... identity and environment attributes ...
});

// 3. Handler returns an error
const result = await listProjects(flags);
// { ok: false, error: { code: "AUTH_TOKEN_EXPIRED", message: "..." } }

// 4. Set error attributes, record exception, set ERROR status
span.setAttributes({
  "cli.exit_code": 1,               // error
  "cli.duration_ms": 12,            // fast failure
  "cli.error_code": "AUTH_TOKEN_EXPIRED",
  "cli.api_request_count": 1,
  "cli.api_request_duration_ms": 8,
  "cli.api_request_errors": 1,
});
span.recordException(result.error); // attaches stack trace as span event
span.setStatus({
  code: SpanStatusCode.ERROR,
  message: "AUTH_TOKEN_EXPIRED",
});
span.end();

// 5. Always: append to local trace file (same as success)

// 6. If consent === "granted": Sentry SDK exports the error span
// Sentry alerts if AUTH_TOKEN_EXPIRED spikes across devices
```

**Workflow command** — `supabase dev` with child spans (connects to ADR 0007):

```typescript
// Root span for the command
const rootSpan = tracer.startSpan("cli.command.dev");

// Child spans for each phase — created by the handler via context propagation
const configSpan = tracer.startSpan("cli.phase.config.load", { parent: rootSpan });
// ... config loads ...
configSpan.setAttribute("cli.phase.duration_ms", 12);
configSpan.end();

const dockerSpan = tracer.startSpan("cli.phase.docker.start", { parent: rootSpan });
// ... docker starts ...
dockerSpan.setAttribute("cli.phase.duration_ms", 890);
dockerSpan.end();

const healthSpan = tracer.startSpan("cli.phase.healthcheck.wait", { parent: rootSpan });
// ... healthcheck passes ...
healthSpan.setAttribute("cli.phase.duration_ms", 230);
healthSpan.end();

// Root span outcome
rootSpan.setAttributes({
  "cli.exit_code": 0,
  "cli.duration_ms": 1200,
  "cli.startup_ms": 38,
});
rootSpan.setStatus({ code: SpanStatusCode.OK });
rootSpan.end();

// Sentry receives a full trace with parent + child spans:
// enables per-phase latency dashboards (e.g. "p95 cli.phase.docker.start duration")

// Local trace file shows the same data via `supabase dev --debug`:
//   supabase dev (total: 1.2s)
//   ├── config.load: 12ms
//   ├── docker.start: 890ms
//   └── healthcheck.wait: 230ms
```

## Consent Implementation

Three-state model stored in `~/.supabase/telemetry.json`:

```typescript
type ConsentState = "pending" | "granted" | "denied";
```

Flow:

```
First CLI run
     │
     ▼
Is TTY? ──No──→ consent = "denied" (no prompt for CI/LLMs)
     │
    Yes
     │
     ▼
Prompt user (via Clack):
"Help improve the Supabase CLI by sending anonymous usage data? (y/N)"
     │
     ├─ y → consent = "granted"
     └─ N → consent = "denied"

At any time:
  supabase telemetry enable   → "granted"
  supabase telemetry disable  → "denied"
  supabase telemetry status   → show current state

Environment override:
  SUPA_TELEMETRY=off      → treated as "denied" (skips prompt)
  SUPA_TELEMETRY=on       → treated as "granted" (skips prompt)
```

Non-TTY defaults to `denied` without prompting — this means LLM agents and CI pipelines never see a consent prompt, and no data is sent unless explicitly enabled via env var or `supabase telemetry enable`.

## Deriving Metrics from Events

Mapping every metric from the 5 categories to a query over span attributes. Queries use TraceQL-like syntax referencing span attributes:

| Category | Metric | Derived from |
|---|---|---|
| Adoption | Monthly Active Users (MAU) | `count(distinct resource.cli.device_id) where span.cli.command exists and timestamp > now() - 30d` |
| Adoption | New installs per week | `count(distinct resource.cli.device_id) where span.cli.is_first_run = true and timestamp > now() - 7d` |
| Adoption | LLM vs human split | `count(*) by span.cli.is_tty` (false = LLM/CI, true = human) |
| Engagement | Commands per session | `count(*) by span.cli.session_id` → average |
| Engagement | Command frequency distribution | `count(*) by span.cli.command order by count desc` |
| Engagement | Multi-command chains | `count(distinct span.cli.session_id) where session_span_count >= 3` |
| Retention | Week 1 retention | `resource.cli.device_id` seen in both week 0 and week 1 after `span.cli.is_first_run = true` |
| Retention | Month 1 retention | `resource.cli.device_id` seen in both month 0 and month 1 after `span.cli.is_first_run = true` |
| Retention | Churn by command | Last `span.cli.command` before a `resource.cli.device_id` stops appearing |
| Quality | Command success rate | `count(span.cli.exit_code = 0) / count(*)` |
| Quality | Error code distribution | `count(*) by span.cli.error_code where span.cli.error_code exists` |
| Quality | p50/p95 command latency | `histogram_quantile(0.50, span.cli.duration_ms)`, `histogram_quantile(0.95, span.cli.duration_ms)` |
| Onboarding | Time to first successful command | `min(timestamp where span.cli.exit_code = 0) - min(timestamp) where span.cli.is_first_run = true` per `resource.cli.device_id` |
| Onboarding | Drop-off funnel | Sequential presence of `is_first_run → cli.command='login' → cli.command='dev' OR cli.command='link'` per `resource.cli.device_id` |

**Phase 1 (Sentry)**: Metrics are derived via Sentry Discover queries filtering on span tags (`cli.command`, `cli.device_id`, etc.). Error code distribution and crash diagnostics use native Sentry Issues.

**Phase 2 (Grafana)**: The same span attributes power Grafana dashboards via TraceQL or PromQL. Long-term retention enables cohort analysis for retention and onboarding metrics that require multi-week time windows.

Completeness check — every span attribute is used by at least one metric:

| Attribute | Used by |
|---|---|
| `resource.cli.device_id` | MAU, retention, churn, onboarding funnel |
| `span.cli.session_id` | Commands per session, multi-command chains |
| `span.cli.is_first_run` | New installs, retention cohorts, onboarding funnel |
| `span.cli.command` | Command frequency, churn by command, drop-off funnel |
| `span.cli.exit_code` | Command success rate |
| `span.cli.duration_ms` | p50/p95 latency |
| `span.cli.startup_ms` | Performance monitoring (ADR 0001 budgets) |
| `span.cli.error_code` | Error code distribution |
| `span.cli.is_tty` | LLM vs human split |
| `span.cli.is_ci` | LLM vs human split (refinement) |
| `resource.os.type`, `resource.host.arch` | Segment any metric by platform |
| `resource.service.version` | Segment any metric by version, track regression |
| `span.cli.api_request_count` | Performance analysis |
| `span.cli.api_request_duration_ms` | Performance analysis |
| `span.cli.api_request_errors` | Quality analysis (backend reliability) |
| child spans (phases) | Per-phase latency breakdown for workflow commands |

Note: `cli.user_id` (Supabase account UUID) is omitted from v1. It will be added as a future enhancement when a profile endpoint is available, enabling cross-device identity linking and per-account error lookup.

Performance impact:

| Operation | Cost |
|---|---|
| Span construction | < 0.1ms |
| Local NDJSON write | < 0.5ms |
| Sentry SDK export (async) | < 0.1ms |
| **Total per command** | **< 1ms** |

## Implementation Status

| Area | Current State | Target State |
|------|--------------|--------------|
| Tracing framework | LogTape structured logging (flat events) | OTel spans via `@sentry/bun` |
| ConsentState | 2-state (`"granted" \| "denied"`) | 3-state (`"pending" \| "granted" \| "denied"`) |
| Default consent | `"granted"` when no config exists | `"denied"` for non-TTY; prompt for TTY |
| API metrics | Fields in type but not collected | Collect from injected API client |
| Remote export | None (local NDJSON + debug only) | Sentry SDK (Phase 1) |
| PII filtering | None | `beforeSend` hooks in Sentry config |
| `cli_version` | Hardcoded `"0.1.0"` | Read from package.json or build constant |
| Child spans | Not implemented | Per-phase spans for workflow commands |
