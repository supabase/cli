# Nx Inference Plugins

This repository keeps one local Nx inference plugin for the Go CLI sidecar.
TypeScript workspaces declare their `types:check` scripts explicitly, and
Turbo orchestrates the repository quality checks. Nx is retained for the CLI
build and live-test graph.

## Current plugin

### `go.plugin.ts`

**Source:** `tools/nx-plugins/src/go.plugin.ts`

The plugin matches `apps/*/go.mod` and adds the Go sidecar's build and lint
targets to the Nx project graph. The default project name is `cli-go` and the
default binary output is `supabase-go`.

| Target       | Command                          | Cached |
| ------------ | -------------------------------- | ------ |
| `build`      | `go build -o supabase-go .`      | Yes    |
| `lint:check` | `golangci-lint run --timeout 5m` | Yes    |
| `lint:fix`   | `golangci-lint run --fix`        | No     |

These are the plugin's inferred defaults. The explicit package scripts take
precedence in the final Nx target configuration; Turbo's cache policy is
defined in `turbo.json`.

The same Go lint commands are also declared in `apps/cli-go/package.json` so
they can be invoked directly and by Turbo quality workflows.

## How to discover inferred targets

To see the Go project's inferred Nx targets and their configuration:

```sh
nx show project cli-go
```

Build and live workflows can invoke the inferred targets through Nx:

```sh
nx run cli-go:build
nx run supabase:test:live
```

Type checks, formatting, linting, and unused-code analysis for the TypeScript
workspaces are explicit package scripts. Run them with Turbo from the root:

```sh
pnpm run check:all
pnpm run fix:all
```

## Adding a new inference plugin

1. Create a new file at `tools/nx-plugins/src/<name>.plugin.ts`.
2. Export a `createNodesV2` function typed as `CreateNodesV2` from `@nx/devkit`.
3. Choose a glob pattern for files that signal a project should receive the
   target.
4. Return `[configFilePath, { projects: { [projectRoot]: { targets } } }]`
   tuples for each matching file.
5. Register the plugin in `nx.json` under the `plugins` array.

```typescript
import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";

export const createNodesV2: CreateNodesV2 = [
  "apps/*/tool.config",
  (configFiles, _options, _context) =>
    configFiles.map((configPath) => {
      const projectRoot = dirname(configPath);

      return [
        configPath,
        {
          projects: {
            [projectRoot]: {
              targets: {
                "tool:check": {
                  command: "tool check",
                  options: { cwd: "{projectRoot}" },
                },
              },
            },
          },
        },
      ];
    }),
];
```

```json
// nx.json
{
  "plugins": ["./tools/nx-plugins/src/go.plugin.ts", "./tools/nx-plugins/src/my-tool.plugin.ts"]
}
```

### Design notes

- Use the package's existing configuration as the detection signal. Avoid
  introducing a separate marker file when the tool's own config is available.
- Prefer fine-grained inputs so cache invalidation follows the tool's actual
  inputs.
- Include external tool dependencies in `inputs` when the inferred target is
  cached.
- Keep Nx plugins focused on build/live graph concerns; declare routine package
  scripts directly when pnpm and Turbo are the consuming interfaces.
