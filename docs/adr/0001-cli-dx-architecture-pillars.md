# 0001. CLI DX Architecture: The 7 Pillars

**Status**: accepted
**Date**: 2026-02-10

## Problem Statement

supabase is the primary entry point to Supabase, consumed by both humans and LLM agents. Traditional CLIs are designed for humans; modern CLIs must serve both without compromise.

Problems we're solving:

1. LLM agents need stable, structured output — but humans need readable, colorful, interactive output
2. Performance perception matters (startup time, command latency)
3. Testing CLI code is harder than testing libraries
4. Observability is often bolted on after the fact
5. Error messages are frequently unhelpful for both humans and machines

## Decision

We establish 7 architectural pillars that every CLI command must follow:

| #   | Pillar                      | Core Principle                                                                    |
| --- | --------------------------- | --------------------------------------------------------------------------------- |
| 1   | Command as Typed Function   | Handlers return typed results. Rendering is separate.                             |
| 2   | Input Design                | Args for "what", flags for "how". Clear precedence chain.                         |
| 3   | Output Design               | Human-first rendering, machine-first data. Auto-detect audience via TTY.          |
| 4   | Error Design                | What failed + why + how to fix. Machine-stable error codes.                       |
| 5   | Observability & Performance | Structured traces from day 0. Performance budgets in CI. Lazy loading.            |
| 6   | Testing Strategy            | 3-layer pyramid: unit, integration, E2E. E2E is the primary layer. High coverage. |
| 7   | LLM-Native Design           | Auto-JSON for non-TTY. Discoverable help. Idempotent commands. Retry hints.       |

## Rationale

These pillars are grounded in research across CLI design guidelines (clig.dev), leading CLIs (GitHub CLI, Wrangler, Vercel CLI), testing strategies (@oclif/test, cli-testing-library), observability standards (OpenTelemetry), and LLM integration patterns. They represent the convergence of human DX and machine DX into a single, coherent architecture.

## The 7 Pillars

**Contents**:

1. [Pillar 1: Command as Typed Function](#pillar-1-command-as-typed-function)
2. [Pillar 2: Input Design](#pillar-2-input-design)
3. [Pillar 3: Output Design](#pillar-3-output-design)
4. [Pillar 4: Error Design](#pillar-4-error-design)
5. [Pillar 5: Observability & Performance](#pillar-5-observability--performance)
6. [Pillar 6: Testing Strategy](#pillar-6-testing-strategy)
7. [Pillar 7: LLM-Native Design](#pillar-7-llm-native-design)

### Pillar 1: Command as Typed Function

Every CLI command is a function with typed inputs and typed outputs. Rendering (human-friendly terminal output vs machine-readable JSON) is a _separate concern_ from command logic.

**Architecture**:

```
┌──────────────────────────────────────────────────┐
│                Command Definition                 │
│  (Stricli: typed flags, args, docs)               │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│                Command Handler                    │
│  Pure logic: validate → execute → return Result   │
│  NO console.log, NO process.exit, NO rendering    │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│                Output Renderer                    │
│  Picks format based on --output flag or TTY:      │
│  • "human" → tables, colors, spinners            │
│  • "json"  → JSON to stdout                      │
│  • "env"   → KEY=VALUE pairs (shell-friendly)    │
└──────────────────────────────────────────────────┘
```

**Types**:

```typescript
type CommandResult<T> = { ok: true; data: T } | { ok: false; error: CommandError };

type CommandError = {
  code: string; // machine-stable: "AUTH_TOKEN_EXPIRED"
  message: string; // human-readable: "Your access token has expired"
  suggestion?: string; // actionable: "Run `supabase login` to refresh"
  metadata?: unknown; // extra context for debugging
};
```

**Example handler**:

```typescript
async function listProjects(flags: ProjectFlags): Promise<CommandResult<Project[]>> {
  const client = await getApiClient();
  const projects = await client.listProjects();
  return { ok: true, data: projects };
}
```

**Why this matters**:

- **For humans**: the renderer shows tables, colors, spinners, interactive prompts
- **For LLMs**: `supabase projects --output json` returns structured, parseable data
- **For testing**: handlers are pure functions — test logic without terminal mocking
- **For piping**: `supabase projects --output json | jq '.[] | .name'` just works

### Pillar 2: Input Design

**Arguments vs flags**:

| Use                   | For                                                       |
| --------------------- | --------------------------------------------------------- |
| Positional arguments  | The primary "what": `supabase branches create my-branch`      |
| Flags                 | Modifiers and options: `--target docker`, `--output json` |
| Stdin                 | Bulk data: `cat migration.sql \| supabase db execute`         |
| Config file           | Persistent defaults: `supabase.config.json`                   |
| Environment variables | Secrets and CI overrides: `SUPABASE_ACCESS_TOKEN`         |

**Precedence** (highest to lowest):

```
CLI flags → Environment variables → Config file → Intelligent defaults
```

**Global flags** (available on every command):

```
--output <format>   Output format: human, json, env (default: auto-detect via TTY)
--project <ref>     Override project ref (instead of config file)
--debug             Show verbose output, timing, API requests
--no-color          Disable color output (also respects NO_COLOR env)
```

**Validation principles**:

- Fail fast, fail clearly — validate all input before any side effects
- Suggest corrections — "Unknown flag `--taget`. Did you mean `--target`?"
- Show what's available — on enum errors, list all valid values

### Pillar 3: Output Design

**For humans — progressive disclosure**:

Show the minimum needed, with escape hatches to see more.

```
$ supabase dev
✓ Loaded config from supabase.config.json
✓ Starting Docker containers...
✓ Database ready on localhost:54322
✓ API ready on localhost:54321
◼ Watching schemas/**/*.sql for changes

  Press q to quit, d for debug info
```

Use steps (checkmarks/crosses) to show progress, not log spam. Show _results_, not _process_. Use color meaningfully: green=success, red=error, yellow=warning, dim=secondary.

**For machines — JSON output**:

Every command's JSON output is a stable contract. Treat it like an API.

```jsonc
// Success
{
  "ok": true,
  "data": [ ... ],
  "metadata": {
    "command": "projects list",
    "duration_ms": 234,
    "api_calls": 1
  }
}

// Error
{
  "ok": false,
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "message": "Your access token has expired",
    "suggestion": "Run `supabase login` to refresh your token"
  }
}
```

**JSON stability rules**:

- Never remove fields in minor versions
- Never change a field's type
- New fields are additive only
- Null means "missing" — never omit the field entirely
- Dates are ISO 8601 strings
- IDs are always strings (even if numeric)

**For shell scripting — env output**:

```
$ supabase status --output env
SUPA_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres
SUPA_API_URL=http://localhost:54321
SUPA_ANON_KEY=eyJ...
SUPA_SERVICE_KEY=eyJ...
```

Enables `eval $(supabase status --output env)` for instant environment setup.

**Output format detection** (priority order):

1. Explicit `--output` flag (user chose)
2. `SUPA_OUTPUT` env var (CI/automation default)
3. `stdout.isTTY` check: TTY = "human", not TTY = "json"

The TTY detection is critical: when an LLM agent runs `supabase projects`, stdout is not a TTY, so it automatically gets JSON. No `--json` flag needed. This matches the `gh` CLI gold standard.

### Pillar 4: Error Design

Errors are the most important output a CLI produces — they're the only output users truly read.

**Error anatomy**:

```
$ supabase dev --target linked

✗ Project not linked

  No project is linked to this directory.
  Run `supabase link` to connect to a Supabase project,
  or use `supabase dev --target docker` for local development.
```

Every error has three parts:

1. **What failed** (bold/red, one line): "Project not linked"
2. **Why it failed** (normal text): "No project is linked to this directory"
3. **How to fix it** (dim text, actionable): "Run `supabase link` to connect..."

**Error codes**:

Every error has a machine-stable code following the `CATEGORY_SPECIFIC_ISSUE` pattern:

```typescript
type ErrorCode =
  | "AUTH_TOKEN_MISSING"
  | "AUTH_TOKEN_EXPIRED"
  | "PROJECT_NOT_LINKED"
  | "PROJECT_NOT_FOUND"
  | "DOCKER_NOT_AVAILABLE"
  | "NETWORK_UNREACHABLE"
  | "CONFIG_INVALID"
  | "CONFIG_NOT_FOUND"
  | "MIGRATION_CONFLICT";
// ...
```

Error codes enable LLM agents to handle errors programmatically, documentation to link to specific error pages, and telemetry to track error frequency.

**Exit codes**:

| Code | Meaning            |
| ---- | ------------------ |
| 0    | Success            |
| 1    | Any error          |
| 130  | Interrupted (Ctrl+C) |

Error categorization (auth vs network vs usage) is communicated through the structured error output (`error.code` field in JSON), not through exit codes. This matches the convention used by most production CLIs (Terraform, kubectl, Wrangler, Vercel).

### Pillar 5: Observability & Performance

Observability is not logging — it's the ability to understand what happened during any command execution, after the fact, without reproducing it.

**Architecture**:

```
┌─────────────────────────────────────────┐
│            Command Execution             │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐│
│  │  Traces  │  │  Metrics │  │  Logs  ││
│  │ (spans)  │  │(counters)│  │(struct)││
│  └────┬─────┘  └────┬─────┘  └───┬────┘│
└───────┼──────────────┼────────────┼─────┘
        │              │            │
        ▼              ▼            ▼
┌─────────────────────────────────────────┐
│           Telemetry Collector            │
│  (in-process, batched, async export)     │
└──────────────┬──────────────────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  Local      Debug     Remote
  file       output    export
  (~/.supabase/  (--debug  (opt-in
   traces/)   flag)    telemetry)
```

**Per-command metrics** (always collected, zero-overhead when not exported):

| Metric                    | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `command.duration_ms`     | Track regressions in command speed           |
| `command.name`            | Know which commands are used                 |
| `command.exit_code`       | Error rates                                  |
| `startup.duration_ms`     | CLI boot time (critical for perceived speed) |
| `api.request_count`       | Network chattiness                           |
| `api.request_duration_ms` | Backend latency vs CLI overhead              |
| `api.request_errors`      | Backend reliability from CLI perspective     |

**Per-phase spans** (trace-level detail):

```
supabase dev (total: 1.2s)
├── config.load: 12ms
├── target.resolve: 3ms
├── docker.check: 45ms
├── docker.start: 890ms
│   ├── postgres: 340ms
│   ├── postgrest: 210ms
│   └── gotrue: 340ms
├── healthcheck.wait: 230ms
└── watcher.start: 8ms
```

**Implementation**: use a lightweight, custom tracing layer — not the full OpenTelemetry SDK, which adds startup latency.

```typescript
const span = trace.start("docker.start");
await startContainers();
span.end(); // records duration
```

**Telemetry consent**:

Local diagnostics (traces written to `~/.supabase/traces/`, `--debug` output) are always available — they stay on the user's machine and require no consent.

Remote telemetry is **opt-in by default** — it is never sent unless the user explicitly consents. See [ADR 0002](0002-cli-product-metrics.md) for consent implementation details.

**Performance budgets** (CI-enforced):

| Operation                            | Budget               |
| ------------------------------------ | -------------------- |
| CLI startup (parse args, no command) | < 50ms               |
| `supabase --help`                        | < 100ms              |
| `supabase status` (local, no network)    | < 200ms              |
| `supabase projects` (network call)       | < 1s (excl. network) |

**Lazy loading is essential**: use dynamic imports so `supabase branches list` doesn't load Docker modules or migration logic. Startup stays fast regardless of how many commands exist.

```typescript
func: async (flags: DevFlags) => {
  const { runDev } = await import("./dev.handler");
  return runDev(flags);
};
```

### Pillar 6: Testing Strategy

**The CLI testing pyramid**:

```
          ╱╲
         ╱  ╲        E2E tests
        ╱    ╲       (real subprocess, real stdout/stderr)
       ╱──────╲
      ╱        ╲     Integration tests
     ╱          ╲    (in-process command execution, mocked I/O)
    ╱────────────╲
   ╱              ╲   Unit tests
  ╱                ╲  (pure handler logic, no I/O)
 ╱──────────────────╲
```

**Layer 1: Unit tests** (fast, many) — test command handlers as pure functions. No terminal, no network, no filesystem.

```typescript
test("listProjects returns projects for org", async () => {
  const api = mockApiClient({ projects: [{ id: "abc", name: "my-app" }] });
  const result = await listProjects({ api });
  expect(result).toEqual({
    ok: true,
    data: [{ id: "abc", name: "my-app" }],
  });
});

test("listProjects returns error when not authenticated", async () => {
  const api = mockApiClient({ authenticated: false });
  const result = await listProjects({ api });
  expect(result).toEqual({
    ok: false,
    error: { code: "AUTH_TOKEN_MISSING", message: expect.any(String) },
  });
});
```

**Layer 2: Integration tests** (medium speed) — test in-process command execution: arg parsing, flag combinations, output rendering, and return values. Uses mocked I/O (captured buffers, mock API server). No real subprocess.

```typescript
test("supabase projects --output json returns valid JSON", async () => {
  const { stdout, exitCode } = await runCommand(["projects", "--output", "json"], {
    env: { SUPABASE_ACCESS_TOKEN: "test-token" },
    api: mockApiServer(),
  });
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toBeArray();
});
```

**Layer 3: E2E tests** (the primary test layer) — spawn the CLI as a real child process via `Bun.spawn`, exercising the same interface that humans and LLMs interact with. This tests the full surface: process boot, arg parsing, TTY detection, stdout/stderr streams, exit codes, and signal handling.

Running from source (`bun run apps/cli/src/index.ts`) is the right default — it exercises identical code paths to a compiled binary while keeping the feedback loop fast. A single smoke test on the compiled artifact in CI covers bundling edge cases.

E2E tests must cover three categories:

**a) TTY auto-detection** — the flagship LLM feature:

```typescript
test("non-TTY stdout produces JSON automatically", async () => {
  const proc = Bun.spawn(["bun", "run", "apps/cli/src/index.ts", "projects"], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: "test-token" },
    stdout: "pipe", // not a TTY → should auto-detect JSON
  });
  const stdout = await new Response(proc.stdout).text();
  expect(() => JSON.parse(stdout)).not.toThrow();
  expect(JSON.parse(stdout).ok).toBe(true);
});
```

**b) Error paths** — LLMs hit errors constantly and rely on structured error output to recover:

```typescript
test("auth failure returns exit code 1 and structured error", async () => {
  const proc = Bun.spawn(["bun", "run", "apps/cli/src/index.ts", "projects"], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" },
    stdout: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const parsed = JSON.parse(stdout);
  expect(proc.exitCode).toBe(1);
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("AUTH_TOKEN_MISSING");
  expect(parsed.error.suggestion).toBeDefined();
});

test("invalid flag returns exit code 1", async () => {
  const proc = Bun.spawn(["bun", "run", "apps/cli/src/index.ts", "--bogus"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  expect(proc.exitCode).toBe(1);
});
```

**c) LLM workflow chains** — commands composed via JSON output, the way agents actually use the CLI:

```typescript
test("LLM workflow: list projects, then get status", async () => {
  // Step 1: list projects
  const list = Bun.spawn(["bun", "run", "apps/cli/src/index.ts", "projects"], {
    stdout: "pipe",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: "test-token" },
  });
  const projects = JSON.parse(await new Response(list.stdout).text());
  expect(projects.ok).toBe(true);
  expect(projects.data.length).toBeGreaterThan(0);

  // Step 2: use output from step 1 to query a specific project
  const ref = projects.data[0].ref;
  const status = Bun.spawn(
    ["bun", "run", "apps/cli/src/index.ts", "status", "--project", ref],
    { stdout: "pipe", env: { ...process.env, SUPABASE_ACCESS_TOKEN: "test-token" } },
  );
  const result = JSON.parse(await new Response(status.stdout).text());
  expect(result.ok).toBe(true);
});
```

**d) Interactive and long-running flows** (CI only):

```typescript
test("supabase dev starts and shows ready status", async () => {
  const proc = Bun.spawn(["bun", "run", "apps/cli/src/index.ts", "dev"], {
    env: { ...process.env, SUPA_TARGET: "docker" },
  });
  const output = await readUntil(proc.stdout, "Ready", { timeout: 30_000 });
  expect(output).toContain("Ready");
  proc.kill();
});
```

**Testing infrastructure**:

| Concern          | Approach                                               |
| ---------------- | ------------------------------------------------------ |
| Test runner      | `bun:test` (native, fast)                              |
| API mocking      | In-process mock server via `Bun.serve()` on port 0     |
| Terminal mocking | Custom `TestRenderer` capturing component output       |
| E2E execution    | `Bun.spawn` running CLI from source as real subprocess |
| Fixtures         | `tests/fixtures/` with sample configs, API responses   |
| CI gating        | All 3 layers must pass before merge                    |

**Test coverage**:

Track and enforce test coverage as a first-class metric. Target **high coverage** (90%+) across the codebase, with particular attention to:

- Command handlers (business logic)
- Error paths and edge cases
- Output rendering for each format (human, json, env)

Use `bun test --coverage` to generate coverage reports. Enforce minimum coverage thresholds in CI — PRs that drop coverage below the threshold cannot merge. Coverage is not a vanity metric here: since both humans and LLMs depend on every code path behaving correctly, untested code is a liability for both audiences.

### Pillar 7: LLM-Native Design

Beyond `--json`, specific patterns make a CLI excellent for LLM agents.

**Auto-detection** (the most important feature): when an LLM agent runs `supabase projects`, stdout is piped (not a TTY). The CLI automatically switches to JSON output. Agents never need to remember `--output json`.

**Discoverable via `--help`**: LLMs read help text to understand commands. Make it structured and complete:

```
$ supabase projects --help

Usage: supabase projects [subcommand]

Subcommands:
  list     List all projects (default)
  create   Create a new project

Flags:
  --output <format>   Output format: human, json, env (default: auto)
  --org <id>          Filter by organization ID

Examples:
  supabase projects                     # List all projects
  supabase projects --output json       # JSON output for scripting
  supabase projects create --org abc    # Create project in org
```

**Idempotent where possible**: LLMs retry on failure. Commands should be safe to retry:

- `supabase link --project abc` — links to project, no-op if already linked
- `supabase migrations push` — pushes only unapplied migrations

**Error recovery hints in JSON**:

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "message": "Access token expired",
    "suggestion": "Run `supabase login` to refresh",
    "retry": false,
    "docs_url": "https://supabase.com/docs/cli/auth"
  }
}
```

The `retry` field tells agents whether retrying might help (e.g., network timeout = true, auth expired = false).

## Consequences

### Positive

- Commands work well for both humans and LLMs from a single codebase
- Pure, testable handlers — test logic without mocking terminals
- Multiple output formats without duplicating business logic
- E2E tests validate the exact interface humans and LLMs interact with
- Observability built in from day 0
- Performance budgets prevent regressions

### Negative

- Requires discipline to follow all 7 pillars consistently
- Output rendering adds a layer of indirection
- High coverage threshold adds CI overhead
- Performance budgets add CI overhead

## Alternatives Considered

1. **Human-first design with JSON bolted on** — leads to inconsistent output formats and poor LLM integration
2. **Machine-first design with human formatting later** — makes UX secondary, results in poor human experience
3. **Monolithic command handlers** — hard to test, impossible to support multiple output formats cleanly
4. **Full OpenTelemetry from day 0** — adds startup latency; lightweight custom layer is better for CLI

## Verification Checklist

To validate these pillars are working:

1. Write one command end-to-end (e.g., `supabase projects list`) implementing all pillars
2. Run in terminal — human-readable output with colors and table formatting
3. Pipe to jq — `supabase projects | jq .` produces valid, stable JSON
4. Run with `--debug` — shows timing spans inline
5. Run tests — unit, integration, E2E tests all pass
6. Check performance — `time supabase --help` completes in < 100ms
7. Simulate LLM — `echo "" | supabase projects` auto-detects non-TTY, outputs JSON

## Related Decisions

- [ADR 0000](0000-use-adr-to-record-decisions.md): Use ADR to Record Decisions
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics
- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI & Documentation Strategy
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals & Development Workflows
- [ADR 0005](0005-openapi-driven-code-generation.md): OpenAPI-Driven Code Generation (references pillars)
- [ADR 0006](0006-environment-management.md): Environment Management (references pillars)
- [ADR 0007](0007-realtime-progress-in-command-handlers.md): Real-time Progress (extends Pillar 1)

## See Also

- [clig.dev — CLI Guidelines](https://clig.dev/)
- [GitHub CLI design patterns](https://cli.github.com/)
- [MADR specification](https://adr.github.io/madr/)
