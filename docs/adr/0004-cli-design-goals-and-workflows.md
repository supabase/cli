# 0004. CLI Design Goals & Development Workflows

**Status**: accepted
**Date**: 2026-02-10

## Problem Statement

The old `supabase` CLI wasn't designed for the two realities of modern Supabase development:

1. **Dual-audience usage** — Both humans and LLM agents need to drive the CLI, but their interaction patterns differ fundamentally. Humans want an interactive orchestrator; LLMs want composable subcommands with structured output.
2. **Two workflow patterns** — Developers need both remote-first development (no local infrastructure, everything goes through the Management API) and local-first development (services running locally, explicit sync with the platform). The old CLI conflates these.
3. **Docker Compose dependency** — The old CLI requires Docker Compose for local development, making it unusable in sandboxed environments (cloud IDEs, Codespaces, AI coding agents) where Docker Compose is unavailable or impractical.

Before building commands, we need to establish _what_ we're building and _why_ — the design goals, the two workflows, the two audiences, and the outside-in command surface that falls out of those decisions.

## Decision

### Two Workflows

#### Remote-first workflow

No local infrastructure. All changes go through the Management API to a project branch — never production.

- **For humans**: `supabase dev` watches local files (migrations, functions, config) and automatically syncs changes to a remote branch. The developer writes code locally, and `dev` pushes it to a hosted Supabase branch in real time.
- **For LLMs**: They chain subcommands directly (`supabase migrations push`, `supabase functions deploy`, etc.) against a remote branch. No orchestrator needed — the subcommands are the API.
- **Goal**: Develop against hosted Supabase without running anything locally. Works everywhere — laptops, cloud IDEs, sandboxes.

#### Local-first workflow

Services run locally via a unified process manager that manages both embedded binaries and Docker containers (for services not yet embedded). No Docker Compose — the CLI owns the process lifecycle directly.

- **For humans**: `supabase dev` starts local services and watches for changes. Same command, different target.
- **For LLMs**: Same subcommands, pointed at local services.
- **Goal**: Full local development environment with explicit `supabase push` / `supabase pull` to sync with the platform.

The workflow is selected via `supabase dev --target <remote|local>` (or equivalent config). The subcommands underneath are identical — only the target changes.

### Two Audiences

#### Humans

The primary entry point is `supabase dev` — an orchestrator that watches files and calls subcommands. It provides an interactive TUI (via React-Ink) showing service status, file watch events, sync progress, and errors. Humans interact with `dev`; `dev` interacts with subcommands.

#### LLMs

The primary entry point is the subcommands directly — `supabase migrations push`, `supabase functions deploy`, `supabase config pull`, etc. LLMs don't need the orchestrator; they compose subcommands via JSON output (auto-detected via TTY, per [ADR 0001](0001-cli-dx-architecture-pillars.md) Pillar 7).

The key insight: **the subcommands that `dev` orchestrates are the same ones LLMs call**. Designing `dev` tells us which subcommands to build first. There is one set of commands, not two CLIs.

### Outside-in Command Surface

Starting from `supabase dev` and working outward, these are the commands to build:

**The orchestrator**:

- `supabase dev` — watches files, calls subcommands, shows TUI. Defines which subcommands matter.

**Subcommands that `dev` orchestrates** (build these first):

| Command group | Subcommands | Purpose |
|--------------|-------------|---------|
| `supabase migrations` | `new`, `push`, `pull`, `list`, `diff` | Schema migration lifecycle |
| `supabase functions` | `new`, `push`, `pull`, `list`, `serve` | Edge Function lifecycle |
| `supabase config` | `push`, `pull`, `diff` | Project configuration sync |
| `supabase env` | `pull`, `push`, `list`, `set`, `unset`, `seed` | Environment variable lifecycle |
| `supabase gen types` | — | TypeScript type generation from schema |

**Supporting commands** (needed for the workflows to function):

| Command | Purpose |
|---------|---------|
| `supabase login` / `supabase logout` | Authentication |
| `supabase init` | Initialize a new project directory |
| `supabase link` | Link directory to a Supabase project |
| `supabase branches` (`create`, `switch`, `list`, `delete`) | Branch management for remote-first workflow |
| `supabase push` / `supabase pull` | Global sync — runs all sub-syncs in parallel |
| `supabase env` (`list-environments`, `create`, `delete`) | Environment CRUD — see [ADR 0006](0006-environment-management.md) |
| `supabase orgs` / `supabase projects` | Organization and project management |

### Safety Model

- **Remote-first** never touches production. All changes target a branch. Merging a branch to production is a platform action, not a CLI action.
- **Local-first** is fully isolated. Local services have no connection to production data.
- **Production access** (if ever needed) requires explicit confirmation — never implicit, never default.

## Rationale

**Outside-in design**: Starting from `supabase dev` and deriving subcommands ensures we build what matters first. Every subcommand exists because `dev` needs it or because a developer workflow requires it — not because we're mirroring an API surface.

**Two workflows, one command set**: The remote-first and local-first workflows use the same subcommands with different targets. This avoids maintaining two parallel command surfaces and means LLMs learn one set of commands that works everywhere.

**`dev` as orchestrator, not monolith**: `supabase dev` doesn't contain business logic — it watches files and calls subcommands. This means each subcommand is independently testable, independently usable by LLMs, and independently documentable.

**No Docker Compose**: The old CLI's Docker Compose dependency is the single biggest barrier to adoption in sandboxed environments. A unified process manager that the CLI controls directly removes this dependency while still supporting Docker containers for services not yet embedded as binaries.

## Consequences

### Positive

- Developers can start with remote-first (zero setup) and move to local-first when they need it
- LLMs get composable, structured subcommands without needing a special mode
- `supabase dev` provides a single entry point that works for both workflows
- The command surface is derived from real workflows, not API mirroring
- No Docker Compose dependency opens the door to sandboxed environments
- Building subcommands first means the CLI is useful before `dev` is complete

### Negative

- Two workflows means more testing surface — every subcommand must work against both remote and local targets
- Remote-first depends on the Management API and branching being reliable and fast
- The process manager (for local-first) is a significant piece of infrastructure to build and maintain
- `supabase dev` is complex — file watching, TUI rendering, orchestrating multiple subcommands, error aggregation

## Alternatives Considered

1. **Keep Docker Compose for local development** — Simpler to implement initially, but blocks sandboxed environments entirely and makes the CLI dependent on Docker Compose's behavior and versioning. The process manager approach gives us full control.

2. **Build separate CLIs for humans and LLMs** — Would allow optimizing each independently, but doubles the maintenance burden and creates divergence over time. The "one set of commands, two entry points" approach avoids this.

3. **Remote-only (no local development)** — Simpler architecture, but many developers need offline or low-latency local development. Local-first is essential for the developer experience.

4. **Mirror the Management API as the command surface** — Would produce a complete but unusable CLI. API surfaces are organized by resource; CLIs should be organized by workflow. Outside-in design from `dev` ensures workflow-first organization.

5. **`dev` contains all logic directly** — Simpler initially, but makes subcommands untestable in isolation, unusable by LLMs, and creates a monolith that's hard to extend.

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture — The 7 Pillars (how commands are structured)
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics (how we measure success)
- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI (how commands document themselves)
- [ADR 0006](0006-environment-management.md): Environment Management & Variable Resolution (env command surface, sync model)
