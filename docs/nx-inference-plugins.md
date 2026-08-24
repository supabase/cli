# Nx Inference Plugins

Some tasks are repetitive to configure: every package that uses `knip` needs the same executor, command, inputs, and caching settings. Instead of duplicating that configuration across every `package.json`, this repo uses local Nx inference plugins to derive tasks automatically from the packages that need them.

## What inference plugins do

An inference plugin is a TypeScript file under `tools/nx-plugins/src/` that exports a `createNodesV2` function. Nx calls this function during project graph construction and merges the returned targets into each matching project's configuration. Targets that come from a plugin are called _inferred targets_ — they don't live in any project file, but they show up in `nx show project` output and work exactly like explicitly declared targets.

The plugin decides which projects get which targets by reading each project's `package.json` and checking for a signal — in the case of knip, the presence of a `knip` configuration object. Projects that don't match the signal are simply skipped.

## Current plugins

### `knip.plugin.ts`

**Source:** `tools/nx-plugins/src/knip.plugin.ts`

Infers `knip:check` and `knip:fix` targets for any workspace package that has a `knip` object in its `package.json`.

**Detection signal:** `package.json` must contain a top-level `"knip"` key whose value is an object (not just the devDependency entry).

**Inferred targets:**

| Target       | Command                                      | Cached | Inputs                                                                                                |
| ------------ | -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `knip:check` | `knip-bun --exclude catalogReferences`       | Yes    | Entry files from `knip.entry` (or `default` if none defined), `sharedGlobals`, `knip` package version |
| `knip:fix`   | `knip-bun --fix --exclude catalogReferences` | No     | —                                                                                                     |

**Input resolution:** If `knip.entry` lists explicit file patterns (e.g. `["src/index.ts", "src/**/*.test.ts"]`), those patterns are used as the cache inputs instead of the broad `default` named input. This means the cache is only invalidated when those specific files change, rather than on any file change in the project. If no `entry` is defined, it falls back to `["default", "sharedGlobals"]`. In both cases, the `knip` package version is included so a version bump triggers a re-check.

### `typescript.plugin.ts`

**Source:** `tools/nx-plugins/src/typescript.plugin.ts`

Infers a `types:check` target for any workspace package that has `typescript` in its `devDependencies`.

**Detection signal:** `package.json` must have `"typescript"` under `devDependencies`.

**No per-project config** — the command is always `tsc --noEmit`.

**Inferred targets:**

| Target        | Command        | Cached | Inputs                                  |
| ------------- | -------------- | ------ | --------------------------------------- |
| `types:check` | `tsc --noEmit` | Yes    | `default`, `typescript` package version |

## How to discover inferred targets

To see all targets for a project, including inferred ones:

```sh
nx show project @supabase/api
```

The inferred targets (`types:check`, `knip:check`, `knip:fix`) will appear in the output under the **Checks** target group even though they are not declared anywhere in `packages/api/package.json`.

To run inferred targets the same way you would any other:

```sh
nx run @supabase/api:knip:check
nx run-many -t types:check knip:check
```

Linting (`oxlint`) and formatting (`oxfmt`) are not inferred per package: they run repo-wide as `lint:check`/`lint:fix`/`fmt:check`/`fmt:fix` targets declared on the `@supabase/root` project in the root `package.json`, configured by `.oxlintrc.json` and `.oxfmtrc.json` at the repo root.

## Adding a new inference plugin

1. Create a new file at `tools/nx-plugins/src/<name>.plugin.ts`
2. Export a `createNodesV2` function typed as `CreateNodesV2` from `@nx/devkit`
3. Choose a glob pattern for the files that signal a project should receive the target (usually `{apps,packages}/*/package.json` filtered by content)
4. Return an array of `[configFilePath, { projects: { [projectRoot]: { targets } } }]` tuples for each matching file
5. Register the plugin in `nx.json` under the `"plugins"` array

```typescript
import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json";

export const createNodesV2: CreateNodesV2 = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      // Check for a signal that this project needs the target
      if (!pkgJson.myTool) return [];

      const projectRoot = dirname(packageJsonPath);

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "my-tool:check": {
                    command: "my-tool-binary",
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs: ["default", "sharedGlobals", { externalDependencies: ["my-tool"] }],
                  },
                },
              },
            },
          },
        ],
      ];
    });
  },
];
```

```json
// nx.json
{
  "plugins": ["./tools/nx-plugins/src/knip.plugin.ts", "./tools/nx-plugins/src/my-tool.plugin.ts"]
}
```

### Design notes

- **Use the package's existing config as the detection signal.** Avoid introducing a separate marker file — the tool's own configuration object in `package.json` is the canonical indicator.
- **Prefer fine-grained inputs.** Read the tool's entry/include patterns from the config object and use them as inputs directly. This avoids false cache misses.
- **Include `externalDependencies`.** Always include `{ externalDependencies: ['<tool-package-name>'] }` in inputs so the cache invalidates when the tool version changes.
- **Commands, not scripts.** Hardcode the binary name (e.g. `knip-bun`) rather than delegating to a `pnpm run` script. This keeps the target self-contained and allows removing the corresponding script from `package.json#scripts`.

## How TypeScript plugins are loaded

With Node 24 and Nx 23.1, Nx loads ESM `.ts` plugins using Node's native TypeScript type-stripping. This is the sole supported plugin loader path. Keep plugins strip-safe (no syntax that requires a transform) and use explicit `.ts` extensions on relative imports.

TypeScript 7 is the workspace's sole TypeScript dependency. Inferred type checks invoke its `tsc` executable directly.
