# `@supabase/process-compose`

An Effect-based TypeScript library for supervising dependency-ordered process graphs under Bun or
Node.js.

The package accepts in-memory `ServiceDef` values and provides lifecycle control, readiness,
health probes, restart policies, state streams, log streams, and optional orphan supervision. It
does not expose a CLI, parse YAML, or run an HTTP server.

```ts
import { buildGraph, Orchestrator } from "@supabase/process-compose";
import { Effect } from "effect";

const graph = await Effect.runPromise(
  buildGraph([
    { name: "database", command: "postgres" },
    {
      name: "api",
      command: "api-server",
      dependencies: [{ service: "database", condition: "healthy" }],
    },
  ]),
);

// Orchestrator.layer(graph) requires a LogBuffer layer and the caller's
// ChildProcessSpawner Adapter.
const orchestratorLayer = Orchestrator.layer(graph);
```

See [the architecture guide](./docs/architecture.md) for the lifecycle, supervision, and compiled
runtime contracts.

## Development

Repo-wide quality checks run from the repository root:

```sh
pnpm check:all
pnpm fix:all
```

Package-local checks and tests run from `packages/process-compose`:

```sh
pnpm types:check
pnpm run test:unit && pnpm run test:integration
```
