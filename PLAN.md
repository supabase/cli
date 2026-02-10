# Plan: supa - A Unified Local/Remote Dev CLI

## Overview

**supa** is a new TypeScript/Bun CLI with a React-Ink terminal UI that provides a unified development experience for Supabase, supporting both local-first and remote-first (preview branches) workflows.

## Architecture

- **Runtime**: Bun
- **Language**: TypeScript
- **Terminal UI**: React-Ink (React for CLIs)
- **Config System**: JSON Schema-based (from experiment-config-json-schema)
- **Structure**: Monorepo with workspaces

## Monorepo Structure

```
supa/
├── packages/
│   ├── config/                    # Config schema package (from experiment-config-json-schema)
│   │   ├── src/
│   │   │   ├── index.ts           # Package exports
│   │   │   ├── base.ts            # Root schema composition
│   │   │   ├── project.ts         # Project settings (id, name)
│   │   │   ├── dev.ts             # Dev command settings
│   │   │   ├── local.ts           # Local Docker settings
│   │   │   ├── linked.ts          # Linked/remote settings
│   │   │   ├── env.ts             # Type-safe environment variable helper
│   │   │   └── lib/
│   │   │       └── secret.ts      # SecretSchema for sensitive fields
│   │   ├── dist/
│   │   │   ├── schema.json        # Generated JSON Schema
│   │   │   ├── types.d.ts         # Generated TypeScript types
│   │   │   └── template.json      # Default config template
│   │   └── package.json
│   │
│   └── cli/                       # Main CLI package
│       ├── src/
│       │   ├── index.ts           # CLI entry point (runs Stricli app)
│       │   ├── app.ts             # Stricli application definition
│       │   ├── commands/
│       │   │   ├── dev/
│       │   │   │   ├── dev.command.ts  # Stricli command definition
│       │   │   │   └── dev.handler.tsx # React-Ink implementation
│       │   │   ├── init/
│       │   │   │   ├── init.command.ts
│       │   │   │   └── init.handler.tsx
│       │   │   ├── login/
│       │   │   │   ├── login.command.ts
│       │   │   │   └── login.handler.tsx
│       │   │   ├── orgs/
│       │   │   │   ├── orgs.command.ts  # RouteMap with list/create
│       │   │   │   └── orgs.handler.tsx
│       │   │   ├── projects/
│       │   │   │   ├── projects.command.ts
│       │   │   │   └── projects.handler.tsx
│       │   │   ├── link/
│       │   │   │   ├── link.command.ts
│       │   │   │   └── link.handler.tsx
│       │   │   ├── branches/
│       │   │   │   ├── branches.command.ts  # RouteMap with create/switch/delete
│       │   │   │   └── branches.handler.tsx
│       │   │   ├── pull/
│       │   │   │   ├── pull.command.ts
│       │   │   │   └── pull.handler.tsx
│       │   │   ├── push/
│       │   │   │   ├── push.command.ts
│       │   │   │   └── push.handler.tsx
│       │   │   ├── migrations/
│       │   │   │   ├── migrations.command.ts  # RouteMap with pull/push/list/new
│       │   │   │   └── migrations.handler.tsx
│       │   │   ├── functions/
│       │   │   │   ├── functions.command.ts  # RouteMap with pull/push/list/new
│       │   │   │   └── functions.handler.tsx
│       │   │   └── config/
│       │   │       ├── config.command.ts  # RouteMap with pull/push/diff
│       │   │       └── config.handler.tsx
│       │   ├── components/
│       │   │   ├── StatusBar.tsx  # Dev mode status display
│       │   │   ├── LogPanel.tsx   # Scrolling log output
│       │   │   ├── FileWatcher.tsx # File change indicators
│       │   │   ├── Confirm.tsx    # Confirmation prompts
│       │   │   ├── Spinner.tsx    # Loading indicator
│       │   │   ├── Onboarding.tsx # Auto-onboarding orchestrator
│       │   │   └── flows/
│       │   │       ├── TargetSelection.tsx  # Target choice UI
│       │   │       └── LinkFlow.tsx         # Project linking UI
│       │   ├── hooks/
│       │   │   ├── useWatcher.ts  # File watching hook
│       │   │   ├── useTarget.ts   # Target resolution hook
│       │   │   └── useWorkflow.ts # Workflow execution hook
│       │   ├── workflows/
│       │   │   ├── base.ts        # Workflow interface
│       │   │   ├── schemas.ts     # Schema workflow
│       │   │   ├── seed.ts        # Seed workflow
│       │   │   └── functions.ts   # Functions workflow
│       │   ├── targets/
│       │   │   ├── base.ts        # Target interface
│       │   │   ├── docker.ts      # Local Docker target
│       │   │   ├── embedded.ts    # Embedded binaries target (sandbox-friendly)
│       │   │   └── remote.ts      # Remote branch target
│       │   ├── api/
│       │   │   ├── client.ts      # Base API client with auth
│       │   │   ├── orgs.ts        # Organization operations
│       │   │   ├── projects.ts    # Project operations
│       │   │   ├── branches.ts    # Branch operations
│       │   │   ├── functions.ts   # Edge functions API
│       │   │   └── config.ts      # Project config API
│       │   ├── sync/
│       │   │   ├── migrations.ts  # Migration sync logic
│       │   │   ├── functions.ts   # Functions sync logic
│       │   │   └── config.ts      # Config sync logic
│       │   └── db/
│       │       ├── connection.ts  # Postgres client
│       │       └── differ.ts      # Schema diffing
│       └── package.json
│
├── package.json                   # Workspace root
├── bun.lockb
└── tsconfig.json
```

## Package: `@supa/config`

### Schema Definition (using jsonv-ts)

**File**: `packages/config/src/dev.ts`

```typescript
import { s } from "jsonv-ts";

export const devSchemas = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the schema workflow",
    }),
    watch: s.array(s.string(), {
      default: ["schemas/**/*.sql"],
      description: "Glob patterns for schema files to watch",
    }),
    on_change: s.string({
      default: "",
      description: "Custom command to run on change (e.g., 'bunx drizzle-kit push')",
    }),
    types: s.string({
      default: "",
      description: "Output path for generated TypeScript types",
    }),
  })
  .partial();

export const devSeed = s
  .strictObject({
    enabled: s.boolean({ default: true }),
    on_change: s.string({ default: "" }),
  })
  .partial();

export const dev = s
  .strictObject({
    default_target: s.string({
      enum: ["docker", "embedded", "linked"],
      default: "docker",
      description: "Default target for dev command (docker, embedded, or linked)",
    }),
    schemas: devSchemas,
    seed: devSeed,
  })
  .partial();
```

**File**: `packages/config/src/base.ts`

```typescript
import { s } from "jsonv-ts";
import { dev } from "./dev";
import { project } from "./project";

export const schema = s
  .strictObject({
    $schema: s.string({ default: "./node_modules/@supa/config/dist/schema.json" }),
    project: project,
    dev: dev,
  })
  .partial();

export type supaConfig = s.Static<typeof schema>;
```

### Type-Safe Environment Variables

**File**: `packages/config/src/env.ts`

````typescript
/**
 * Type-safe environment variable access.
 *
 * Usage:
 * ```typescript
 * type Env = {
 *   SUPABASE_ACCESS_TOKEN: string;
 *   OAUTH_CLIENT_ID: string;
 *   OAUTH_CLIENT_SECRET: string;
 * };
 *
 * const env = createEnv<Env>();
 *
 * // Type-safe access - autocomplete works!
 * const token = env("SUPABASE_ACCESS_TOKEN");
 *
 * // With default value
 * const clientId = env("OAUTH_CLIENT_ID", "default-id");
 *
 * // TypeScript error: Argument of type '"INVALID_KEY"' is not assignable
 * const invalid = env("INVALID_KEY");
 * ```
 */

export type EnvGetter<T extends Record<string, string>> = {
  <K extends keyof T>(key: K): string;
  <K extends keyof T>(key: K, defaultValue: string): string;

  // Get all defined env vars as object
  all(): Partial<T>;

  // Check if env var is defined
  has<K extends keyof T>(key: K): boolean;

  // Require env var (throws if missing)
  require<K extends keyof T>(key: K): string;
};

export function createEnv<T extends Record<string, string>>(): EnvGetter<T> {
  const getter = (<K extends keyof T>(key: K, defaultValue?: string): string => {
    const value = process.env[key as string];
    if (value !== undefined) {
      return value;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    return "";
  }) as EnvGetter<T>;

  getter.all = () => {
    const result: Partial<T> = {};
    // Note: We can't enumerate T keys at runtime, so this returns
    // all process.env vars. Type safety is enforced at call sites.
    return result;
  };

  getter.has = <K extends keyof T>(key: K): boolean => {
    return process.env[key as string] !== undefined;
  };

  getter.require = <K extends keyof T>(key: K): string => {
    const value = process.env[key as string];
    if (value === undefined) {
      throw new Error(`Required environment variable "${String(key)}" is not set`);
    }
    return value;
  };

  return getter;
}

// Re-export for convenience
export { createEnv as env };
````

**Usage in CLI**:

```typescript
// packages/cli/src/env.ts
import { createEnv } from "@supa/config";

// Define all environment variables used by the CLI
type CliEnv = {
  // Auth
  SUPABASE_ACCESS_TOKEN: string;

  // OAuth (for `supa login`)
  SUPABASE_OAUTH_CLIENT_ID: string;
  SUPABASE_OAUTH_CLIENT_SECRET: string;

  // Database (optional overrides)
  DATABASE_URL: string;

  // Debug
  DEBUG: string;
};

export const env = createEnv<CliEnv>();

// Usage in code:
// const token = env("SUPABASE_ACCESS_TOKEN");
// const token = env.require("SUPABASE_ACCESS_TOKEN"); // throws if missing
// if (env.has("DEBUG")) { ... }
```

### Config Files Supported

Users can write config in any of these formats:

- `supa.config.json` (with `$schema` for IDE autocomplete)
- `supa.config.ts` (TypeScript with `satisfies supaConfig`)
- `supa.config.js` (JavaScript)

**Example**: `supa.config.json`

```json
{
  "$schema": "./node_modules/@supa/config/dist/schema.json",
  "project": {
    "id": "abc123"
  },
  "dev": {
    "default_target": "local",
    "schemas": {
      "watch": ["schemas/**/*.sql"],
      "types": "src/types/database.ts"
    }
  }
}
```

**Example**: `supa.config.ts`

```typescript
import type { supaConfig } from "@supa/config";

export default {
  project: { id: "abc123" },
  dev: {
    schemas: {
      watch: ["schemas/**/*.sql"],
      types: "src/types/database.ts",
    },
  },
} satisfies supaConfig;
```

## Package: `@supa/cli`

### React-Ink Terminal UI

**File**: `packages/cli/src/commands/dev.tsx`

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { StatusBar } from "../components/StatusBar";
import { LogPanel } from "../components/LogPanel";
import { useWatcher } from "../hooks/useWatcher";
import { useTarget } from "../hooks/useTarget";
import { useWorkflow } from "../hooks/useWorkflow";

interface DevProps {
  local?: boolean;
  linked?: boolean;
}

export function Dev({ local, linked }: DevProps) {
  const { exit } = useApp();
  const [logs, setLogs] = useState<string[]>([]);

  // Resolve target (local Docker or remote branch)
  const { target, isProduction, loading: targetLoading } = useTarget({ local, linked });

  // Production safety check
  const [confirmed, setConfirmed] = useState(!isProduction);

  // File watcher
  const { changedFiles, watching } = useWatcher(target);

  // Workflows
  const { status, execute } = useWorkflow(target);

  // Handle file changes
  useEffect(() => {
    if (changedFiles.length > 0 && confirmed) {
      execute(changedFiles);
    }
  }, [changedFiles]);

  // Keyboard shortcuts
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
    if (input === "y" && isProduction && !confirmed) {
      setConfirmed(true);
    }
  });

  // Production confirmation screen
  if (isProduction && !confirmed) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">⚠️ Warning: You're targeting PRODUCTION</Text>
        <Text>Project: {target?.name}</Text>
        <Text dimColor>Press 'y' to confirm, 'q' to quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar target={target} status={status} watching={watching} />
      <LogPanel logs={logs} />
      <Text dimColor>Press 'q' to quit</Text>
    </Box>
  );
}
```

**File**: `packages/cli/src/components/StatusBar.tsx`

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Target } from "../targets/base";

interface StatusBarProps {
  target: Target | null;
  status: "idle" | "applying" | "error";
  watching: boolean;
}

export function StatusBar({ target, status, watching }: StatusBarProps) {
  const modeColor = target?.isRemote ? "cyan" : "green";
  const modeLabel = target?.isRemote ? "LINKED" : "LOCAL";

  return (
    <Box borderStyle="single" paddingX={1}>
      <Text>
        <Text color={modeColor} bold>
          [{modeLabel}]
        </Text>{" "}
        <Text>{target?.name ?? "..."}</Text>
        {" | "}
        <Text color={status === "error" ? "red" : "white"}>
          {status === "applying" ? "⟳ Applying..." : status === "error" ? "✗ Error" : "✓ Ready"}
        </Text>
        {watching && <Text dimColor> | Watching...</Text>}
      </Text>
    </Box>
  );
}
```

### CLI Framework: Stricli

We use [Stricli](https://bloomberg.github.io/stricli/) for type-safe CLI argument parsing with zero dependencies.

**File**: `packages/cli/src/commands/dev/dev.command.ts`

```typescript
import { buildCommand } from "@stricli/core";

type DevFlags = {
  readonly target?: "docker" | "embedded" | "linked";
  readonly linked?: boolean; // Shorthand for --target linked
  readonly skipOnboarding?: boolean;
};

export const command = buildCommand({
  func: async (flags: DevFlags) => {
    const { runDev } = await import("./dev.handler");
    return runDev(flags);
  },
  parameters: {
    flags: {
      target: {
        brief: "Target environment (docker, embedded, or linked)",
        kind: "enum",
        values: ["docker", "embedded", "linked"],
        optional: true,
      },
      linked: {
        brief: "Shorthand for --target linked",
        kind: "boolean",
        optional: true,
      },
      skipOnboarding: {
        brief: "Skip the interactive setup wizard",
        kind: "boolean",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  docs: {
    brief: "Start reactive development mode",
  },
});
```

**File**: `packages/cli/src/commands/dev/dev.handler.tsx`

```tsx
import React from "react";
import { render } from "ink";
import { Dev } from "../../components/Dev";
import { Onboarding } from "../../components/Onboarding";
import { loadConfig, configExists } from "../../config/loader";
import { isLinked } from "../../api/client";

export async function runDev(flags: { target?: string; linked?: boolean }) {
  // Step 1: Check if project needs onboarding
  const needsInit = !(await configExists());
  const needsLink = flags.linked && !(await isLinked());

  if (needsInit || needsLink) {
    // Run interactive onboarding flow
    render(
      <Onboarding
        needsInit={needsInit}
        needsLink={needsLink}
        onComplete={() => {
          // After onboarding, start dev mode
          render(<Dev target={flags.target} linked={flags.linked} />);
        }}
      />,
    );
    return;
  }

  // Step 2: Start dev mode directly
  render(<Dev target={flags.target} linked={flags.linked} />);
}
```

### Onboarding Flow

When `supa dev` is run without a config, it guides the user through setup:

```
┌─────────────────────────────────────────────────────────────┐
│  supa dev                                                   │
│                                                             │
│  1. Config exists?                                          │
│     NO  → Run init flow:                                    │
│           a. Choose target: docker / embedded / linked      │
│           b. If linked → Run link flow (select org/project) │
│           c. Create supa.config.json                    │
│     YES → Continue                                          │
│                                                             │
│  2. Target requires linking but not linked?                 │
│     YES → Run link flow                                     │
│                                                             │
│  3. Start dev mode with configured target                   │
└─────────────────────────────────────────────────────────────┘
```

**Target Selection UI** (during init):

```
┌─────────────────────────────────────────────────────────────┐
│  How do you want to develop?                                │
│                                                             │
│  ● Local (Docker)                                           │
│    Full Supabase stack running in Docker containers         │
│                                                             │
│  ○ Local (Embedded)                                         │
│    Lightweight local dev without Docker (sandbox-friendly)  │
│                                                             │
│  ○ Remote (Linked)                                          │
│    Develop against a remote Supabase project/branch         │
└─────────────────────────────────────────────────────────────┘
```

**File**: `packages/cli/src/components/Onboarding.tsx`

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import { TargetSelection } from "./flows/TargetSelection";
import { LinkFlow } from "./flows/LinkFlow";
import { writeConfig } from "../../config/loader";

interface OnboardingProps {
  onComplete: (config: supaConfig) => void;
}

type Step = "target" | "link" | "done";

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("target");
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Welcome to supa!
      </Text>
      <Text dimColor>Let's set up your project...</Text>

      <Box marginTop={1}>
        {step === "target" && (
          <TargetSelection
            onSelect={(target) => {
              setSelectedTarget(target);
              if (target === "linked") {
                setStep("link");
              } else {
                // Create config and finish
                const config = { dev: { default_target: target } };
                writeConfig(config);
                onComplete(config);
              }
            }}
          />
        )}

        {step === "link" && (
          <LinkFlow
            onComplete={(projectId) => {
              const config = {
                project: { id: projectId },
                dev: { default_target: selectedTarget },
              };
              writeConfig(config);
              onComplete(config);
            }}
          />
        )}
      </Box>
    </Box>
  );
}
```

**File**: `packages/cli/src/components/flows/TargetSelection.tsx`

```tsx
import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

interface TargetSelectionProps {
  onSelect: (target: "docker" | "embedded" | "linked") => void;
}

export function TargetSelection({ onSelect }: TargetSelectionProps) {
  const items = [
    {
      label: "Local (Docker) - Full Supabase stack in containers",
      value: "docker",
    },
    {
      label: "Local (Embedded) - Lightweight, no Docker required",
      value: "embedded",
    },
    {
      label: "Remote (Linked) - Develop against a remote project",
      value: "linked",
    },
  ];

  return (
    <Box flexDirection="column">
      <Text>How do you want to develop?</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onSelect(item.value as any)} />
      </Box>
    </Box>
  );
}
```

**File**: `packages/cli/src/commands/branches/branches.command.ts`

```typescript
import { buildCommand, buildRouteMap } from "@stricli/core";

// supa branches create <name>
const create = buildCommand({
  func: async (flags: {}, name: string) => {
    const { createBranch } = await import("./branches.handler");
    return createBranch(name);
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Branch name", parse: String, placeholder: "name" }],
    },
  },
  docs: { brief: "Create a preview branch" },
});

// supa branches switch <name>
const switchBranch = buildCommand({
  func: async (flags: {}, name: string) => {
    const { switchToBranch } = await import("./branches.handler");
    return switchToBranch(name);
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Branch name", parse: String, placeholder: "name" }],
    },
  },
  docs: { brief: "Switch to a branch" },
});

// supa branches (list)
const list = buildCommand({
  func: async () => {
    const { listBranches } = await import("./branches.handler");
    return listBranches();
  },
  parameters: {
    flags: {},
    positional: { kind: "tuple", parameters: [] },
  },
  docs: { brief: "List all branches" },
});

export const branches = buildRouteMap({
  routes: { create, switch: switchBranch, list },
  docs: { brief: "Manage preview branches" },
});
```

**File**: `packages/cli/src/app.ts`

```typescript
import { buildApplication, buildRouteMap } from "@stricli/core";
import { command as dev } from "./commands/dev/dev.command";
import { command as init } from "./commands/init/init.command";
import { command as login } from "./commands/login/login.command";
import { command as link } from "./commands/link/link.command";
import { command as pull } from "./commands/pull/pull.command";
import { command as push } from "./commands/push/push.command";
import { branches } from "./commands/branches/branches.command";
import { orgs } from "./commands/orgs/orgs.command";
import { projects } from "./commands/projects/projects.command";
import { migrations } from "./commands/migrations/migrations.command";
import { functions } from "./commands/functions/functions.command";
import { config } from "./commands/config/config.command";

const root = buildRouteMap({
  routes: {
    dev,
    init,
    login,
    link,
    pull,
    push,
    branches,
    orgs,
    projects,
    migrations,
    functions,
    config,
  },
  docs: { brief: "supa CLI - Unified local/remote Supabase development" },
});

export const app = buildApplication(root, {
  name: "supa",
  versionInfo: {
    currentVersion: "0.1.0",
  },
});
```

**File**: `packages/cli/src/index.ts`

```typescript
#!/usr/bin/env bun
import { run } from "@stricli/core";
import { app } from "./app";

run(app, process.argv.slice(2), {
  process,
});
```

## Implementation Phases

### Phase 1: Monorepo Setup

1. Initialize Bun workspace in `/Users/jgoux/Code/supabase/supa`
2. Create `packages/config` with jsonv-ts schema definitions
3. Create `packages/cli` with React-Ink setup
4. Configure shared TypeScript settings

**Root `package.json`:**

```json
{
  "name": "supa",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "bun run --filter @supa/cli dev",
    "build": "bun run --filter '*' build",
    "generate:schema": "bun run --filter @supa/config generate"
  }
}
```

### Phase 2: Config Package

1. Port jsonv-ts schema patterns from experiment-config-json-schema
2. Define schemas for: project, dev, local, linked
3. Generate: schema.json, types.d.ts, template.json
4. Implement config loader (supports .json, .ts, .js)

### Phase 3: CLI Package - Core

1. Set up React-Ink with Bun
2. Implement target abstraction (local/remote)
3. Implement Supabase Management API client
4. Create file watcher hook with chokidar

### Phase 4: CLI Package - Dev Command

1. Build StatusBar, LogPanel, Confirm components
2. Implement schema workflow
3. Implement seed workflow
4. Wire up dev command with all workflows

### Phase 5: CLI Package - Auth & API Client

1. Implement credential storage (`~/.supa/credentials.json`)
2. `supa login` - authenticate and store token
3. Build base API client with auth header injection
4. Implement org, project, branch API modules

### Phase 6: CLI Package - Resource Management Commands

1. `supa orgs` / `supa orgs create` - organization management
2. `supa projects` / `supa projects create` - project management (with interactive region/plan selection)
3. `supa link` - link local project to remote
4. `supa branches` - branch management

### Phase 7: CLI Package - Sync Commands (Pull/Push)

1. Implement sync modules:
   - `sync/migrations.ts` - pull/push migration files
   - `sync/functions.ts` - pull/push edge functions
   - `sync/config.ts` - pull/push project config
2. Individual commands:
   - `supa migrations pull/push/list/new`
   - `supa functions pull/push/list/new`
   - `supa config pull/push/diff`
3. Global sync commands:
   - `supa pull` - runs all pull operations in parallel with React-Ink progress UI
   - `supa push` - runs all push operations in parallel with React-Ink progress UI

## Dependencies

### `@supa/config`

```json
{
  "dependencies": {
    "jsonv-ts": "^0.10.1"
  }
}
```

### `@supa/cli`

```json
{
  "dependencies": {
    "@supa/config": "workspace:*",
    "@stricli/core": "^1.0.0",
    "ink": "^5.0.1",
    "ink-select-input": "^6.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1",
    "chokidar": "^3.6.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.3"
  }
}
```

## Target Environments

supa supports three target environments to accommodate different development contexts:

| Target       | Description                              | Use Case                                                        |
| ------------ | ---------------------------------------- | --------------------------------------------------------------- |
| **docker**   | Local Supabase via Docker containers     | Full local dev with all services                                |
| **embedded** | Local Supabase via embedded npm binaries | Sandboxed environments (StackBlitz, CodeSandbox, restricted CI) |
| **linked**   | Remote Supabase project/branch           | Preview branches, remote-first development                      |

### Target Selection

Target is chosen by the user (stored in config), not auto-detected:

```bash
supa dev                    # Uses default_target from config
supa dev --target docker    # Override: use Docker
supa dev --target embedded  # Override: use embedded binaries
supa dev --target linked    # Override: use linked remote
supa dev --linked           # Shorthand for --target linked
```

During onboarding, the user is asked to choose their preferred target.

### Target Architecture

```
packages/cli/src/targets/
├── base.ts           # Target interface
├── docker.ts         # Docker-based local target
├── embedded.ts       # Embedded binaries target (npm packages)
└── remote.ts         # Remote/linked target
```

**File**: `packages/cli/src/targets/base.ts`

```typescript
export interface Target {
  name: string;
  type: "docker" | "embedded" | "linked";
  isRemote: boolean;
  isProduction: boolean; // true for main branch on linked

  connect(): Promise<Connection>;
  applySQL(sql: string): Promise<void>;
  getSchema(): Promise<Schema>;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

export interface TargetFactory {
  detect(): Promise<boolean>; // Can this target be used?
  create(config: supaConfig): Promise<Target>;
}
```

**File**: `packages/cli/src/targets/embedded.ts`

```typescript
// Embedded target uses npm-published binaries for:
// - PostgreSQL (e.g., @aspect/embedded-postgres or similar)
// - PostgREST
// - GoTrue (auth)
// - Other Supabase services as they become available
//
// This enables local development in sandboxed environments
// where Docker is not available (StackBlitz, CodeSandbox, etc.)

export class EmbeddedTarget implements Target {
  type = "embedded" as const;
  isRemote = false;
  isProduction = false;

  // TODO: Implement when embedded binaries are published
  // Will use npm packages like:
  // - @supa/embedded-postgres
  // - @supa/embedded-postgrest
  // - @supa/embedded-gotrue
}
```

### Target Resolution

```typescript
async function resolveTarget(
  config: supaConfig,
  flags: { target?: string; linked?: boolean },
): Promise<Target> {
  // 1. CLI flag takes precedence
  const targetType = flags.linked
    ? "linked"
    : (flags.target ?? config.dev?.default_target ?? "docker");

  // 2. Create target based on type
  switch (targetType) {
    case "docker":
      if (!(await DockerTarget.isAvailable())) {
        throw new Error("Docker is not available. Install Docker or use --target embedded/linked");
      }
      return new DockerTarget(config);

    case "embedded":
      if (!(await EmbeddedTarget.isAvailable())) {
        throw new Error("Embedded binaries not available. Use --target docker/linked");
      }
      return new EmbeddedTarget(config);

    case "linked":
      if (!config.project?.id) {
        throw new Error(
          "Project not linked. Run 'supa link' first or use --target docker/embedded",
        );
      }
      return new RemoteTarget(config);

    default:
      throw new Error(`Unknown target: ${targetType}`);
  }
}
```

## Safety Model

| Target                          | Confirmation Required              |
| ------------------------------- | ---------------------------------- |
| Local (docker)                  | Never                              |
| Local (embedded)                | Never                              |
| Preview branch (linked)         | Never                              |
| Main/production branch (linked) | Always (React-Ink confirmation UI) |

## CLI Commands

### Authentication

| Command       | Description                                          |
| ------------- | ---------------------------------------------------- |
| `supa login`  | Authenticate with Supabase (opens browser for token) |
| `supa logout` | Remove stored credentials                            |

### Organization Management

| Command                   | Description               |
| ------------------------- | ------------------------- |
| `supa orgs`               | List your organizations   |
| `supa orgs create <name>` | Create a new organization |

### Project Management

| Command                | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `supa projects`        | List projects in current org                                  |
| `supa projects create` | Create a new project (interactive - select org, region, etc.) |

### Local Project Setup

| Command     | Description                            |
| ----------- | -------------------------------------- |
| `supa init` | Create supa.config.json with defaults  |
| `supa link` | Link to Supabase project (interactive) |

### Development

| Command                      | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `supa dev`                   | Start dev mode (uses target from config, runs onboarding if needed) |
| `supa dev --target docker`   | Override: use Docker containers                                     |
| `supa dev --target embedded` | Override: use embedded binaries                                     |
| `supa dev --target linked`   | Override: use linked remote                                         |
| `supa dev --linked`          | Shorthand for `--target linked`                                     |
| `supa dev --skip-onboarding` | Skip onboarding (fail if not configured)                            |

**Onboarding:** If no config exists, `supa dev` runs an interactive setup:

1. **Choose target**: docker / embedded / linked
2. **If linked**: Select org → project → branch
3. **Create config**: Saves `supa.config.json`

### Branch Management

| Command                       | Description                      |
| ----------------------------- | -------------------------------- |
| `supa branches`               | List branches for linked project |
| `supa branches create <name>` | Create preview branch            |
| `supa branches switch <name>` | Switch active branch             |
| `supa branches delete <name>` | Delete a preview branch          |

### Sync Commands (Pull/Push)

**Global sync** (runs all in parallel):
| Command | Description |
|---------|-------------|
| `supa pull` | Pull all (migrations + functions + config) from remote |
| `supa push` | Push all (migrations + functions + config) to remote |

**Migrations**:
| Command | Description |
|---------|-------------|
| `supa migrations pull` | Pull migrations from remote to local |
| `supa migrations push` | Push local migrations to remote |
| `supa migrations list` | List local and remote migrations |
| `supa migrations new <name>` | Create a new migration file |

**Edge Functions**:
| Command | Description |
|---------|-------------|
| `supa functions pull` | Download functions from remote |
| `supa functions push` | Deploy functions to remote |
| `supa functions list` | List local and remote functions |
| `supa functions new <name>` | Create a new function |

**Config**:
| Command | Description |
|---------|-------------|
| `supa config pull` | Pull remote config to local |
| `supa config push` | Push local config to remote |
| `supa config diff` | Show diff between local and remote config |

## Verification Plan

### Setup

1. `bun install` at monorepo root
2. `bun run generate:schema` - generates config artifacts

### Authentication Flow

3. `supa login` - opens browser, stores token in ~/.supa/credentials.json
4. Verify token stored correctly

### Resource Management

5. `supa orgs` - lists organizations
6. `supa orgs create test-org` - creates new org
7. `supa projects` - lists projects
8. `supa projects create` - interactive project creation (select org, region)
9. Wait for project health check to pass

### Local Development

10. `supa init` - creates supa.config.json
11. `supa link` - link to created project
12. `supa dev` - starts local mode with React-Ink UI
13. Edit schema file - see changes reflected in UI and applied

### Remote Development

14. `supa branches create feature-test` - create preview branch
15. `supa dev --linked` - targets preview branch (no confirmation)
16. Edit schema file - see changes applied to preview branch
17. `supa branches switch main` - switch to main
18. `supa dev --linked` - shows confirmation UI for production

### Sync Commands

19. `supa pull` - pulls migrations, functions, config in parallel (shows progress UI)
20. Make local changes to a function
21. `supa functions push` - pushes single function
22. `supa push` - pushes all changes in parallel
23. `supa config diff` - shows diff between local and remote config

## Supabase Management API

**Base URL**: `https://api.supabase.com/v1`
**Auth**: Bearer token from https://supabase.com/dashboard/account/tokens

### API Client Structure

**File**: `packages/cli/src/api/client.ts`

```typescript
interface ManagementAPIClient {
  // Auth token stored in ~/.supa/credentials.json
  token: string;

  // Organizations
  listOrgs(): Promise<Organization[]>;
  createOrg(name: string): Promise<Organization>;

  // Projects
  listProjects(): Promise<Project[]>;
  createProject(opts: CreateProjectOpts): Promise<Project>;
  getProject(ref: string): Promise<Project>;
  getProjectHealth(ref: string): Promise<HealthStatus>;

  // Branches
  listBranches(projectRef: string): Promise<Branch[]>;
  createBranch(projectRef: string, name: string): Promise<Branch>;
  getBranch(branchId: string): Promise<Branch>;
  deleteBranch(branchId: string): Promise<void>;

  // Edge Functions
  listFunctions(projectRef: string): Promise<EdgeFunction[]>;
  getFunction(projectRef: string, slug: string): Promise<EdgeFunction>;
  createFunction(projectRef: string, opts: CreateFunctionOpts): Promise<EdgeFunction>;
  updateFunction(projectRef: string, slug: string, opts: UpdateFunctionOpts): Promise<EdgeFunction>;
  deleteFunction(projectRef: string, slug: string): Promise<void>;

  // Project Config
  getConfig(projectRef: string): Promise<ProjectConfig>;
  updateConfig(projectRef: string, config: Partial<ProjectConfig>): Promise<ProjectConfig>;

  // Regions
  getAvailableRegions(): Promise<Region[]>;
}
```

### Key Endpoints

| Endpoint                              | Method | Description           |
| ------------------------------------- | ------ | --------------------- |
| `/v1/organizations`                   | GET    | List organizations    |
| `/v1/organizations`                   | POST   | Create organization   |
| `/v1/projects`                        | GET    | List projects         |
| `/v1/projects`                        | POST   | Create project        |
| `/v1/projects/{ref}`                  | GET    | Get project details   |
| `/v1/projects/{ref}/health`           | GET    | Check service health  |
| `/v1/projects/available-regions`      | GET    | Get available regions |
| `/v1/projects/{ref}/branches`         | GET    | List branches         |
| `/v1/projects/{ref}/branches`         | POST   | Create branch         |
| `/v1/branches/{id}`                   | DELETE | Delete branch         |
| `/v1/projects/{ref}/functions`        | GET    | List edge functions   |
| `/v1/projects/{ref}/functions`        | POST   | Create edge function  |
| `/v1/projects/{ref}/functions/{slug}` | GET    | Get function details  |
| `/v1/projects/{ref}/functions/{slug}` | PATCH  | Update function       |
| `/v1/projects/{ref}/functions/{slug}` | DELETE | Delete function       |
| `/v1/projects/{ref}/config`           | GET    | Get project config    |
| `/v1/projects/{ref}/config`           | PATCH  | Update project config |

### Credential Storage

**File**: `~/.supa/credentials.json`

```json
{
  "access_token": "sbp_..."
}
```

## External References

- [Management API Docs](https://supabase.com/docs/reference/api/introduction)
- [Create Organization](https://supabase.com/docs/reference/api/create-an-organization)
- [Create Project](https://supabase.com/docs/reference/api/v1-create-a-project)
- [Stricli docs](https://bloomberg.github.io/stricli/) - Type-safe CLI framework
- [Ink docs](https://github.com/vadimdemedes/ink) - React for CLIs
- [jsonv-ts](https://github.com/jquense/jsonv-ts) - JSON Schema builder

## Key Files to Create

| File                                         | Purpose                         |
| -------------------------------------------- | ------------------------------- |
| `package.json`                               | Monorepo workspace config       |
| `packages/config/src/base.ts`                | Root config schema              |
| `packages/config/src/dev.ts`                 | Dev command schema              |
| `packages/cli/src/index.tsx`                 | CLI entry point                 |
| `packages/cli/src/commands/login.tsx`        | Login command                   |
| `packages/cli/src/commands/orgs.tsx`         | Organization management         |
| `packages/cli/src/commands/projects.tsx`     | Project management              |
| `packages/cli/src/commands/dev.tsx`          | Dev command React-Ink UI        |
| `packages/cli/src/components/StatusBar.tsx`  | Status display component        |
| `packages/cli/src/components/SelectList.tsx` | Interactive selection component |
| `packages/cli/src/hooks/useWatcher.ts`       | File watching hook              |
| `packages/cli/src/targets/base.ts`           | Target interface                |
| `packages/cli/src/targets/docker.ts`         | Local Docker target             |
| `packages/cli/src/targets/embedded.ts`       | Embedded binaries target        |
| `packages/cli/src/targets/remote.ts`         | Remote branch target            |
| `packages/cli/src/api/client.ts`             | Base API client with auth       |
| `packages/cli/src/api/orgs.ts`               | Organization API operations     |
| `packages/cli/src/api/projects.ts`           | Project API operations          |
| `packages/cli/src/api/branches.ts`           | Branch API operations           |
| `packages/cli/src/sync/migrations.ts`        | Migration sync logic            |
| `packages/cli/src/sync/functions.ts`         | Functions sync logic            |
| `packages/cli/src/sync/config.ts`            | Config sync logic               |
