# Nx Inference Plugins

This repository keeps one local Nx inference plugin for the Go CLI sidecar.
TypeScript workspaces declare their `types:check` scripts explicitly, and
Turbo orchestrates repository build, generation, and quality checks. Nx is
retained for live and auxiliary workflows and dependency inspection.

## Current plugin

### `go.plugin.ts`

**Source:** `tools/nx-plugins/src/go.plugin.ts`

The plugin matches `apps/*/go.mod` and adds the Go sidecar's build and lint
targets to the Nx project graph. The default project name is `cli-go` and the
default binary output is `supabase-go`.

| Target       | Command                          | Cached |
| ------------ | -------------------------------- | ------ |
| `build`      | `go build -o supabase-go .`      | No     |
| `lint:check` | `golangci-lint run --timeout 5m` | Yes    |
| `lint:fix`   | `golangci-lint run --fix`        | No     |

These are the plugin's inferred defaults. The explicit package scripts take
precedence in the final Nx target configuration, and the retained Nx build
bridge is uncached so live runs always prepare fresh artifacts. Turbo's cache
policy for ordinary builds is defined in `turbo.json`.

The same Go lint commands are also declared in `apps/cli-go/package.json` so
they can be invoked directly and by Turbo quality workflows.

## How to discover inferred targets

To see the Go project's inferred Nx targets and their configuration:

```sh
nx show project cli-go
```

Use Turbo for builds and generation; use Nx for the retained live workflow:

```sh
pnpm exec turbo run @supabase/cli-go#build
pnpm exec turbo run supabase#build
nx run supabase:test:live
```

Type checks are explicit package scripts, while formatting, linting, and
unused-code analysis are root-owned scripts. Run all repository quality checks
with Turbo from the root:

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
