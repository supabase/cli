# @supabase/process-compose

TypeScript port of [process-compose](https://github.com/F1bonacc1/process-compose) for Bun. Orchestrates multiple processes with health checks, an HTTP API, and structured logging. Zero runtime dependencies.

## Usage

As a library:

```ts
import { createProcessCompose } from "@supabase/process-compose";

const pc = await createProcessCompose({
  configPath: "process-compose.yaml",
  apiPort: 8080,
});

await pc.start();
```

As a CLI:

```sh
bun run packages/process-compose/src/cli.ts -f process-compose.yaml
```

## Development

```sh
bun run --parallel "*:check"   # Run all quality checks in parallel
bun run --parallel "*:fix"     # Auto-fix lint, format, and unused exports in parallel
bun test                       # Run tests
```
