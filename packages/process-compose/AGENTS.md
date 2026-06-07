# Process Compose

Effect V4 service orchestrator — manages a dependency graph of services with health checks, log streaming, and lifecycle management.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full architecture document with diagrams.

- `ServiceDef.ts` — Pure data types for service definitions
- `ServiceState.ts` — Runtime state machine
- `DependencyGraph.ts` — Topological ordering using `effect/Graph`
- `HealthProbe.ts` — Health check runner (HTTP/exec/TCP probes) via `ChildProcessSpawner`
- `LogBuffer.ts` — Per-service log capture + streaming via `PubSub`
- `Orchestrator.ts` — Core coordinator using `FiberMap` + `Deferred` + `SubscriptionRef`

## Testing

Use `bun run test` (not `bun test`) to run tests — we use vitest.

Uses `@effect/vitest` with `it.effect` / `it.live`. Mock factories in `tests/helpers/mocks.ts`.

Always run the relevant unit and integration tests for the workspace you changed.
Do not automatically run unrelated e2e tests. Only run targeted e2e coverage when the user asks, or when the specific command or surface you touched needs it.
