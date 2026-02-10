# Telemetry Implementation

> Extracted from [ADR 0002](adr/0002-cli-product-metrics.md). This document covers the implementation details of the CLI telemetry system. For the metric categories, event schema contract, and architectural decisions, see the ADR.

## Unified Infrastructure

ADR 0001 Pillar 5 and ADR 0002 share infrastructure. No separate metrics SDK and tracing SDK — one telemetry event schema, one write path, one consent model. Two remote services handle distinct concerns:

| Service | Purpose | Data | Consent |
|---|---|---|---|
| **PostHog** | Product analytics — all 5 metric categories | `TelemetryEvent` (anonymous usage) | Opt-in |
| **Sentry** | Product health — crash reporting, error diagnostics | Errors with stack traces and context | Opt-in (same consent) |

```
┌─────────────────────────────────────────────┐
│              Command Execution               │
│                                              │
│  handler logic → withTelemetry() middleware  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ TelemetryEvent  │
          │ (single schema) │
          └────────┬────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
Local file      --debug       Remote
~/.supa/        output        export
traces/         (always)      (opt-in)
(always)           │          ┌──┴──┐
     │             │          ▼     ▼
     ▼             ▼       PostHog  Sentry
Observability  Observability (product (errors,
(ADR 0001      (ADR 0001    metrics) crashes)
 Pillar 5)      Pillar 5)
```

PostHog receives every `TelemetryEvent` and powers dashboards for all 5 metric categories. Sentry receives error events only (when `exit_code != 0`) with stack traces, error codes, and environment context for debugging and alerting.

## Collection Architecture

`withTelemetry()` middleware wrapping Stricli command handlers. The middleware:

- Records `startup_ms` (time from process start to handler entry)
- Runs the handler
- Records `duration_ms`, `exit_code`, `error_code`
- Collects API stats from an injected API client
- Emits a single `TelemetryEvent`
- Handlers never interact with telemetry directly

Pattern:

```typescript
function withTelemetry<T>(handler: CommandHandler<T>): CommandHandler<T> {
  return async (flags) => {
    const start = performance.now();
    const result = await handler(flags);
    const event: TelemetryEvent = {
      schema_version: 1,
      command: flags.__command,
      exit_code: result.ok ? 0 : exitCodeFromError(result.error),
      duration_ms: performance.now() - start,
      startup_ms: start - globalThis.__processStart,
      // ... remaining fields populated from context
    };
    telemetry.record(event); // non-blocking
    return result;
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

`device_id`: random UUID generated on first run, persisted in `~/.supa/telemetry.json`. Never changes unless the file is deleted. This is the only identity before the user runs `supa login`.

`session_id`: random UUID that rotates after 30 minutes of inactivity (no CLI commands). This defines "session" for the Engagement metrics.

`is_first_run`: true only on the very first CLI execution ever (when `telemetry.json` doesn't exist yet). Powers the Onboarding metrics.

**Identified phase** — after `supa login`:

Once the user authenticates, the Supabase account UUID is available from the auth token. This enables linking the anonymous device to a known account:

```
Before login:        device_id = "a1b2c3d4-..."  (anonymous)
                     user_id = undefined

supa login           ← user authenticates

After login:         device_id = "a1b2c3d4-..."  (same device)
                     user_id = "f9e8d7c6-..."    (Supabase account UUID)
```

**PostHog identity resolution** — `posthog.identify()` merges the anonymous and identified profiles:

```typescript
// On successful `supa login`, called once:
posthog.identify({
  distinctId: deviceId,           // same device_id used as anonymous distinct_id
  properties: {
    supabase_user_id: userId,     // Supabase account UUID from auth token
  },
});
```

After this call, PostHog merges all previous anonymous events (from `device_id`) with the identified profile. The onboarding funnel (install → first run → login → first meaningful command) is now traceable as a single user journey. If the same account logs in on a different device, PostHog links both devices to one user.

**Sentry identity resolution** — `Sentry.setUser()` attaches the account to subsequent error reports:

```typescript
// On successful `supa login`:
Sentry.setUser({ id: userId });

// On `supa logout`:
Sentry.setUser(null);
```

This enables support workflows: "show me all CLI errors for this Supabase account" in the Sentry dashboard. The user ID is only attached to error events, not set as a global tag.

**Identity lifecycle**:

```
┌─────────────┐     supa login      ┌──────────────┐
│  Anonymous   │ ──────────────────→ │  Identified   │
│              │                     │               │
│  device_id ✓ │     PostHog:        │  device_id ✓  │
│  user_id ✗   │     identify()      │  user_id ✓    │
│              │     Sentry:         │               │
│              │     setUser()       │               │
└─────────────┘                     └───────┬───────┘
                                            │
                                     supa logout
                                            │
                                            ▼
                                    ┌──────────────┐
                                    │  Anonymous    │
                                    │               │
                                    │  device_id ✓  │
                                    │  user_id ✗    │
                                    └──────────────┘
                                    Sentry: setUser(null)
                                    PostHog: reverts to
                                    device_id only
```

Privacy guarantees:

| What we track | What we never track |
|---|---|
| Random device UUID | IP address, username, hostname |
| Supabase account UUID (after login) | Email, name, or other profile data |
| Command name and exit code | Command arguments or flag values |
| Timing and error codes | File paths, SQL content, project names |
| OS and architecture | Stack traces (PostHog), environment variables |

## Local Storage

NDJSON files in `~/.supa/traces/`:

- One file per day: `2025-01-15.ndjson`
- 7-day automatic retention (older files deleted on CLI startup)
- Always written regardless of consent — this is the user's own machine
- Powers `--debug` output and local diagnostics (ADR 0001 Pillar 5)
- Same `TelemetryEvent` format as remote export

## Remote Export

Two services, one consent gate:

**PostHog** — product metrics:

- Receives every `TelemetryEvent` as a PostHog event via `posthog-node`
- `device_id` maps to PostHog's `distinct_id` (anonymous, no user identification)
- Event properties map directly from `TelemetryEvent` fields
- Powers all 5 metric category dashboards, funnels, and retention analysis
- Fire-and-forget — `posthog.capture()` is non-blocking, events are batched internally by the SDK (flush every 20 events or every 30 seconds)

**Sentry** — product health and debugging:

- Initialized via `@sentry/bun` with lazy loading (only imported when consent is granted)
- Captures unhandled exceptions and command errors (`exit_code != 0`)
- Attaches context: `command`, `error_code`, `cli_version`, `os`, `arch`, `is_tty`, `is_ci`
- No PII — `beforeSend` hook strips file paths, environment variables, and usernames
- Enables alerting on error spikes and debugging with full stack traces
- Sentry's `dsn` is bundled in the CLI — standard practice, not a secret

Shared behavior:

- Neither service sends data unless consent is `granted`
- Neither blocks command execution
- Both are lazy-loaded to avoid startup cost when consent is `denied`

Performance: total overhead < 1ms per command (event construction + non-blocking SDK calls).

### End-to-end example: `supa projects list`

**Success path** — user runs `supa projects list` and gets a list of projects:

```typescript
// 1. withTelemetry() wraps the handler
const start = performance.now(); // 45ms after process start
const result = await listProjects(flags); // { ok: true, data: [...] }

// 2. Construct the event
const event: TelemetryEvent = {
  schema_version: 1,
  device_id: "a1b2c3d4-...",       // from ~/.supa/telemetry.json
  session_id: "e5f6g7h8-...",       // current session
  is_first_run: false,
  command: "projects list",
  exit_code: 0,
  duration_ms: 234,
  startup_ms: 45,
  is_tty: true,
  is_ci: false,
  os: "darwin",
  arch: "arm64",
  cli_version: "0.1.0",
  api_request_count: 1,
  api_request_duration_ms: 189,
  api_request_errors: 0,
};

// 3. Always: append to local trace file
// ~/.supa/traces/2025-01-15.ndjson += JSON.stringify(event) + "\n"

// 4. If consent === "granted": send to PostHog
posthog.capture({
  distinctId: event.device_id,
  event: "cli_command",
  properties: {
    command: "projects list",
    exit_code: 0,
    duration_ms: 234,
    startup_ms: 45,
    is_tty: true,
    is_ci: false,
    os: "darwin",
    arch: "arm64",
    cli_version: "0.1.0",
    api_request_count: 1,
    api_request_duration_ms: 189,
    api_request_errors: 0,
  },
});
// Non-blocking — SDK batches internally

// 5. Sentry: nothing to do (exit_code === 0, no error)
```

**Error path** — user runs `supa projects list` but their token has expired:

```typescript
// 1. Handler returns an error
const result = await listProjects(flags);
// { ok: false, error: { code: "AUTH_TOKEN_EXPIRED", message: "..." } }

// 2. Construct the event (same as success, but with error fields)
const event: TelemetryEvent = {
  // ... same identity and environment fields ...
  command: "projects list",
  exit_code: 3,                      // auth error
  duration_ms: 12,                   // fast failure
  startup_ms: 45,
  error_code: "AUTH_TOKEN_EXPIRED",
  api_request_count: 1,
  api_request_duration_ms: 8,
  api_request_errors: 1,
};

// 3. Always: append to local trace file (same as success)

// 4. If consent === "granted": send to PostHog (same as success)
posthog.capture({
  distinctId: event.device_id,
  event: "cli_command",
  properties: {
    command: "projects list",
    exit_code: 3,
    duration_ms: 12,
    error_code: "AUTH_TOKEN_EXPIRED",
    // ... remaining fields ...
  },
});

// 5. If consent === "granted": report to Sentry
Sentry.captureMessage("AUTH_TOKEN_EXPIRED", {
  level: "warning",
  tags: {
    command: "projects list",
    error_code: "AUTH_TOKEN_EXPIRED",
    exit_code: 3,
    cli_version: "0.1.0",
  },
  contexts: {
    runtime: { os: "darwin", arch: "arm64", is_tty: true, is_ci: false },
  },
});
// Sentry alerts fire if AUTH_TOKEN_EXPIRED spikes across users
```

**Workflow command** — `supa dev` with spans (connects to ADR 0007):

```typescript
// Progress events from the handler become spans in the telemetry event
const event: TelemetryEvent = {
  // ... identity and environment fields ...
  command: "dev",
  exit_code: 0,
  duration_ms: 1200,
  startup_ms: 38,
  api_request_count: 0,
  api_request_duration_ms: 0,
  api_request_errors: 0,
  spans: [
    { name: "config.load", duration_ms: 12 },
    { name: "docker.start", duration_ms: 890 },
    { name: "healthcheck.wait", duration_ms: 230 },
  ],
};

// PostHog receives the full event including spans —
// enables per-phase latency dashboards (e.g. "p95 docker.start time")

// Local trace file shows the same data via `supa dev --debug`:
//   supa dev (total: 1.2s)
//   ├── config.load: 12ms
//   ├── docker.start: 890ms
//   └── healthcheck.wait: 230ms
```

## Consent Implementation

Three-state model stored in `~/.supa/telemetry.json`:

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
"Help improve supa by sending anonymous usage data? (y/N)"
     │
     ├─ y → consent = "granted"
     └─ N → consent = "denied"

At any time:
  supa telemetry enable   → "granted"
  supa telemetry disable  → "denied"
  supa telemetry status   → show current state

Environment override:
  SUPA_TELEMETRY=off      → treated as "denied" (skips prompt)
  SUPA_TELEMETRY=on       → treated as "granted" (skips prompt)
```

Non-TTY defaults to `denied` without prompting — this means LLM agents and CI pipelines never see a consent prompt, and no data is sent unless explicitly enabled via env var or `supa telemetry enable`.

## Deriving Metrics from Events

Mapping every metric from the 5 categories to a query over TelemetryEvent fields:

| Category | Metric | Derived from |
|---|---|---|
| Adoption | Monthly Active Users (MAU) | `COUNT(DISTINCT device_id) WHERE timestamp > now() - 30d` |
| Adoption | New installs per week | `COUNT(DISTINCT device_id) WHERE is_first_run = true AND timestamp > now() - 7d` |
| Adoption | LLM vs human split | `COUNT(*) GROUP BY is_tty` (false = LLM/CI, true = human) |
| Engagement | Commands per session | `COUNT(*) GROUP BY session_id` → average |
| Engagement | Command frequency distribution | `COUNT(*) GROUP BY command ORDER BY count DESC` |
| Engagement | Multi-command chains | `COUNT(DISTINCT session_id) WHERE session_command_count >= 3` |
| Retention | Week 1 retention | `device_id` seen in both week 0 and week 1 after `is_first_run` |
| Retention | Month 1 retention | `device_id` seen in both month 0 and month 1 after `is_first_run` |
| Retention | Churn by command | Last `command` before a `device_id` stops appearing |
| Quality | Command success rate | `COUNT(exit_code = 0) / COUNT(*)` |
| Quality | Error code distribution | `COUNT(*) GROUP BY error_code WHERE error_code IS NOT NULL` |
| Quality | p50/p95 command latency | `PERCENTILE(duration_ms, 0.50)`, `PERCENTILE(duration_ms, 0.95)` |
| Onboarding | Time to first successful command | `MIN(timestamp WHERE exit_code = 0) - MIN(timestamp) WHERE is_first_run` per `device_id` |
| Onboarding | Drop-off funnel | Sequential presence of `is_first_run → command='login' → command='dev' OR command='link'` per `device_id` |

Completeness check — every field in `TelemetryEvent` is used by at least one metric:

| Field | Used by |
|---|---|
| `device_id` | MAU, retention, churn, onboarding funnel |
| `user_id` | Cross-device identity, PostHog profile merge, Sentry error lookup |
| `session_id` | Commands per session, multi-command chains |
| `is_first_run` | New installs, retention cohorts, onboarding funnel |
| `command` | Command frequency, churn by command, drop-off funnel |
| `exit_code` | Command success rate |
| `duration_ms` | p50/p95 latency |
| `startup_ms` | Performance monitoring (ADR 0001 budgets) |
| `error_code` | Error code distribution |
| `is_tty` | LLM vs human split |
| `is_ci` | LLM vs human split (refinement) |
| `os`, `arch` | Segment any metric by platform |
| `cli_version` | Segment any metric by version, track regression |
| `api_request_count` | Performance analysis |
| `api_request_duration_ms` | Performance analysis |
| `api_request_errors` | Quality analysis (backend reliability) |
| `spans` | Per-phase latency breakdown for workflow commands |

Performance impact:

| Operation | Cost |
|---|---|
| Event construction | < 0.1ms |
| Local NDJSON write | < 0.5ms |
| PostHog capture (async) | < 0.1ms |
| Sentry context attach | < 0.1ms |
| **Total per command** | **< 1ms** |
