# Micro Stacks Phase 1 — `@supabase/stack` Changes + `@supabase/fleet` Daemon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@supabase/stack` pods template-provisioned, micro-tuned, and lazily started, and add a new `@supabase/fleet` package: a host-level daemon giving 100+ registered pods with suspend-on-idle, wake-on-connect, and CoW fork/reset.

**Architecture:** `@supabase/stack` stays the pod runtime (supervise processes for one stack); `@supabase/fleet` is a new package owning what exists when pods don't: pod/port registries, template store, CoW provisioning, a TCP wake-proxy edge, and idle timers. Fleet hosts warm pods as in-process `StackHandle`s. Spec: `docs/specs/2026-07-07-micro-supabase-stacks-design.md` (in this repo).

**Tech Stack:** TypeScript on Bun, Effect 4 (beta, via pnpm `catalog:`), vitest, nx, `node:net` for TCP splicing (works on Bun and Node), `node:crypto` for hashing.

## Global Constraints

- Work in `/Users/jgoux/Code/supabase/cli/.claude/worktrees/micro-supabase-stacks-spec`, branch `claude/nifty-dhawan-86e0c6`'s sibling `claude/micro-supabase-stacks-spec`. Never commit to `develop`.
- `@supabase/stack` is unpublished — breaking API changes are allowed.
- All new deps via `catalog:` in `pnpm-workspace.yaml`; run `pnpm install` after editing any package.json.
- Test naming: `*.unit.test.ts` (no I/O), `*.integration.test.ts` (may spawn postgres), `*.e2e.test.ts` (full stacks, serial). Runner: vitest via nx (`pnpm vitest run <file>` works directly inside a package).
- Effect style: `Context.Service` classes, `Layer`, `Effect.gen`; public APIs are Promise-based wrappers via `ManagedRuntime` (mirror `createStack.ts:694-763`).
- Postgres micro profile values are normative from the spec — copy exactly (note the real GUC name is `wal_writer_delay`).
- On-disk layout: `~/.supabase/templates/<key>/data`, `~/.supabase/pods/<id>/{data,pod.json,logs}`, `~/.supabase/fleet-state.json` (tests must override the root via options — never touch the real `~/.supabase` in tests; use `mkdtemp`).
- Commit after every task with a conventional-commit message.
- Windows: fleet features are macOS/Linux native-mode only in this phase; `mode: "docker"` paths must keep compiling and existing tests must keep passing.

---

### Task 1: Scaffold `@supabase/fleet` package

**Files:**
- Create: `packages/fleet/package.json`
- Create: `packages/fleet/tsconfig.json`
- Create: `packages/fleet/src/index.ts`
- Test: `packages/fleet/src/index.unit.test.ts`

**Interfaces:**
- Produces: an empty package `@supabase/fleet` that later tasks fill; exports nothing yet but `FLEET_PACKAGE` marker for the scaffold test.

- [ ] **Step 1: Write package.json** (mirror `packages/cli-test-helpers/package.json` conventions)

```json
{
  "name": "@supabase/fleet",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "nx run-many -t test:core --projects=$npm_package_name",
    "check:all": "nx run-many -t types:check lint:check fmt:check knip:check --projects=$npm_package_name",
    "fix:all": "nx run-many -t lint:fix fmt:fix knip:fix --projects=$npm_package_name"
  },
  "dependencies": {
    "@supabase/process-compose": "workspace:*",
    "@supabase/stack": "workspace:*",
    "effect": "catalog:"
  },
  "devDependencies": {
    "@tsconfig/bun": "catalog:",
    "@types/bun": "catalog:",
    "@vitest/coverage-istanbul": "catalog:",
    "knip": "catalog:",
    "oxfmt": "catalog:",
    "oxlint": "catalog:",
    "vitest": "catalog:"
  },
  "knip": {
    "entry": ["src/**/*.test.ts"],
    "ignoreDependencies": ["@typescript/native-preview", "oxfmt", "oxlint", "oxlint-tsgolint"],
    "ignoreBinaries": ["nx"]
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "types": ["bun"]
  }
}
```

- [ ] **Step 3: Write src/index.ts and a smoke test**

```typescript
// src/index.ts
export const FLEET_PACKAGE = "@supabase/fleet";
```

```typescript
// src/index.unit.test.ts
import { describe, expect, it } from "vitest";
import { FLEET_PACKAGE } from "./index.ts";

describe("fleet scaffold", () => {
  it("exports the package marker", () => {
    expect(FLEET_PACKAGE).toBe("@supabase/fleet");
  });
});
```

- [ ] **Step 4: Install and run**

Run: `pnpm install && cd packages/fleet && pnpm vitest run src/index.unit.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet pnpm-lock.yaml
git commit -m "feat(fleet): scaffold @supabase/fleet package"
```

---

### Task 2: Micro profile module in `@supabase/stack`

**Files:**
- Create: `packages/stack/src/micro.ts`
- Test: `packages/stack/src/micro.unit.test.ts`

**Interfaces:**
- Produces:
  - `MICRO_POSTGRES_SETTINGS: ReadonlyArray<readonly [string, string]>`
  - `buildMicroConf(): string` — full `micro.conf` file content
  - `PRELOAD_REQUIRED_EXTENSIONS: ReadonlySet<string>`
  - `buildPodConf(preloadLibraries: ReadonlyArray<string>): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/micro.unit.test.ts
import { describe, expect, it } from "vitest";
import {
  buildMicroConf,
  buildPodConf,
  MICRO_POSTGRES_SETTINGS,
  PRELOAD_REQUIRED_EXTENSIONS,
} from "./micro.ts";

describe("micro profile", () => {
  it("contains the normative spec settings", () => {
    const map = new Map(MICRO_POSTGRES_SETTINGS);
    expect(map.get("shared_buffers")).toBe("16MB");
    expect(map.get("jit")).toBe("off");
    expect(map.get("fsync")).toBe("off");
    expect(map.get("wal_level")).toBe("logical");
    expect(map.get("max_slot_wal_keep_size")).toBe("256MB");
    expect(map.get("wal_writer_delay")).toBe("10s");
  });

  it("renders micro.conf as key = 'value' lines", () => {
    const conf = buildMicroConf();
    expect(conf).toContain("shared_buffers = '16MB'");
    expect(conf).toContain("max_connections = '40'");
    expect(conf.endsWith("\n")).toBe(true);
  });

  it("knows which extensions need preload", () => {
    expect(PRELOAD_REQUIRED_EXTENSIONS.has("pg_cron")).toBe(true);
    expect(PRELOAD_REQUIRED_EXTENSIONS.has("pgvector")).toBe(false);
  });

  it("renders pod.conf with shared_preload_libraries", () => {
    expect(buildPodConf(["pg_cron", "pg_net"])).toBe(
      "shared_preload_libraries = 'pg_cron,pg_net'\n",
    );
    expect(buildPodConf([])).toBe("shared_preload_libraries = ''\n");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/stack && pnpm vitest run src/micro.unit.test.ts`
Expected: FAIL — cannot resolve `./micro.ts`.

- [ ] **Step 3: Implement**

```typescript
// src/micro.ts
/**
 * Micro profile: normative values from
 * docs/specs/2026-07-07-micro-supabase-stacks-design.md ("The micro.conf profile").
 */
export const MICRO_POSTGRES_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  // memory
  ["shared_buffers", "16MB"],
  ["work_mem", "4MB"],
  ["maintenance_work_mem", "32MB"],
  ["jit", "off"],
  ["huge_pages", "off"],
  ["max_connections", "40"],
  // background CPU
  ["autovacuum_naptime", "5min"],
  ["autovacuum_max_workers", "1"],
  ["bgwriter_lru_maxpages", "0"],
  ["wal_writer_delay", "10s"],
  ["checkpoint_timeout", "30min"],
  ["max_parallel_workers", "0"],
  ["max_parallel_workers_per_gather", "0"],
  ["max_worker_processes", "4"],
  ["track_io_timing", "off"],
  // durability (disposable profile)
  ["fsync", "off"],
  ["synchronous_commit", "off"],
  ["full_page_writes", "off"],
  // replication reservations
  ["wal_level", "logical"],
  ["max_wal_senders", "5"],
  ["max_replication_slots", "5"],
  ["max_slot_wal_keep_size", "256MB"],
  ["wal_keep_size", "0"],
];

export const buildMicroConf = (): string =>
  `${MICRO_POSTGRES_SETTINGS.map(([k, v]) => `${k} = '${v}'`).join("\n")}\n`;

/** Extensions that only work when named in shared_preload_libraries. */
export const PRELOAD_REQUIRED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pg_cron",
  "pg_net",
  "timescaledb",
  "pg_stat_statements",
  "auto_explain",
  "pgaudit",
  "plan_filter",
  "supautils",
  "pgsodium",
]);

export const buildPodConf = (preloadLibraries: ReadonlyArray<string>): string =>
  `shared_preload_libraries = '${preloadLibraries.join(",")}'\n`;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/stack && pnpm vitest run src/micro.unit.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src/micro.ts packages/stack/src/micro.unit.test.ts
git commit -m "feat(stack): add micro postgres profile and preload-required registry"
```

---

### Task 3: PGDATA conf-layering utilities

**Files:**
- Create: `packages/stack/src/pgconf.ts`
- Test: `packages/stack/src/pgconf.unit.test.ts`

**Interfaces:**
- Consumes: `buildMicroConf`, `buildPodConf` from Task 2.
- Produces (all plain async, `node:fs/promises` — used by both stack and fleet):
  - `installMicroProfile(pgdata: string): Promise<void>` — writes `micro.conf` + empty `pod.conf` into PGDATA and appends include lines to `postgresql.conf` once (idempotent)
  - `readPreloadLibraries(pgdata: string): Promise<string[]>`
  - `writePreloadLibraries(pgdata: string, libs: ReadonlyArray<string>): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pgconf.unit.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installMicroProfile,
  readPreloadLibraries,
  writePreloadLibraries,
} from "./pgconf.ts";

async function fakePgdata(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pgconf-test-"));
  await writeFile(join(dir, "postgresql.conf"), "# stock conf\nport = 5432\n");
  return dir;
}

describe("pgconf", () => {
  it("installs micro.conf, pod.conf, and include lines idempotently", async () => {
    const pgdata = await fakePgdata();
    await installMicroProfile(pgdata);
    await installMicroProfile(pgdata); // idempotent
    const main = await readFile(join(pgdata, "postgresql.conf"), "utf8");
    expect(main.match(/include_if_exists = 'micro\.conf'/g)).toHaveLength(1);
    expect(main.match(/include_if_exists = 'pod\.conf'/g)).toHaveLength(1);
    // pod.conf must be included AFTER micro.conf so pod overrides micro
    expect(main.indexOf("micro.conf")).toBeLessThan(main.indexOf("pod.conf"));
    const micro = await readFile(join(pgdata, "micro.conf"), "utf8");
    expect(micro).toContain("shared_buffers = '16MB'");
  });

  it("round-trips preload libraries via pod.conf", async () => {
    const pgdata = await fakePgdata();
    await installMicroProfile(pgdata);
    expect(await readPreloadLibraries(pgdata)).toEqual([]);
    await writePreloadLibraries(pgdata, ["pg_cron"]);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron"]);
    await writePreloadLibraries(pgdata, ["pg_cron", "pg_net"]);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron", "pg_net"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/stack && pnpm vitest run src/pgconf.unit.test.ts`
Expected: FAIL — cannot resolve `./pgconf.ts`.

- [ ] **Step 3: Implement**

```typescript
// src/pgconf.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMicroConf, buildPodConf } from "./micro.ts";

const INCLUDE_BLOCK = [
  "",
  "# --- supabase micro profile (managed; do not edit below) ---",
  "include_if_exists = 'micro.conf'",
  "include_if_exists = 'pod.conf'",
  "",
].join("\n");

export async function installMicroProfile(pgdata: string): Promise<void> {
  await writeFile(join(pgdata, "micro.conf"), buildMicroConf());
  const podConf = join(pgdata, "pod.conf");
  const existing = await readFile(podConf, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await writeFile(podConf, buildPodConf([]));
  }
  const mainPath = join(pgdata, "postgresql.conf");
  const main = await readFile(mainPath, "utf8");
  if (!main.includes("include_if_exists = 'micro.conf'")) {
    await writeFile(mainPath, main + INCLUDE_BLOCK);
  }
}

export async function readPreloadLibraries(pgdata: string): Promise<string[]> {
  const content = await readFile(join(pgdata, "pod.conf"), "utf8").catch(() => "");
  const match = content.match(/^shared_preload_libraries = '([^']*)'/m);
  if (!match || match[1] === "") return [];
  return match[1].split(",");
}

export async function writePreloadLibraries(
  pgdata: string,
  libs: ReadonlyArray<string>,
): Promise<void> {
  await writeFile(join(pgdata, "pod.conf"), buildPodConf(libs));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/stack && pnpm vitest run src/pgconf.unit.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src/pgconf.ts packages/stack/src/pgconf.unit.test.ts
git commit -m "feat(stack): PGDATA conf layering (micro.conf + pod.conf includes)"
```

---

### Task 4: `provisioned` + `profile` on PostgresConfig; skip init; version bump

**Files:**
- Modify: `packages/stack/src/StackBuilder.ts` (PostgresConfig ~line 42-169; service assembly ~line 556-870)
- Modify: `packages/stack/src/services/postgres.ts` (NATIVE_POSTGRES_RUNTIME_ARGS, lines 44-51)
- Modify: `packages/stack/src/versions.ts` (DEFAULT_VERSIONS, line ~49)
- Test: `packages/stack/src/StackBuilder.provisioned.unit.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `PostgresConfig` gains `readonly provisioned?: boolean` (data dir is a pre-initialized template clone → **exclude the `postgres-init` service entirely**) and `readonly profile?: "default" | "micro"`.
  - When `profile: "micro"`, the native postgres ServiceDef gets NO `-c` runtime args (micro.conf in PGDATA carries them; command-line `-c` would override users' `ALTER SYSTEM`). When `profile` is absent/default, current behavior is unchanged.
  - `DEFAULT_VERSIONS.postgres` becomes `"17.6.1.143"`.

- [ ] **Step 1: Write the failing test**

Find the existing StackBuilder unit tests for reference on constructing a `ResolvedStackConfig`/builder in isolation (see `packages/stack/tests/` and any `StackBuilder*.test.ts`; follow the same fixture helpers). The test asserts on the built ServiceDef list:

```typescript
// src/StackBuilder.provisioned.unit.test.ts
// NOTE: reuse the existing StackBuilder test fixture pattern in this package for
// constructing a builder; the assertions below are the contract.
import { describe, expect, it } from "vitest";
import { buildServicesForTest } from "../tests/helpers/buildServices.ts"; // create if absent, wrapping StackBuilder.build() with a minimal ResolvedStackConfig fixture

describe("provisioned postgres", () => {
  it("excludes postgres-init when postgres.provisioned is true", async () => {
    const services = await buildServicesForTest({ postgres: { provisioned: true } });
    expect(services.map((s) => s.name)).not.toContain("postgres-init");
  });

  it("includes postgres-init by default", async () => {
    const services = await buildServicesForTest({});
    expect(services.map((s) => s.name)).toContain("postgres-init");
  });

  it("drops -c runtime args when profile is micro", async () => {
    const services = await buildServicesForTest({
      postgres: { provisioned: true, profile: "micro" },
    });
    const pg = services.find((s) => s.name === "postgres");
    expect(pg?.args?.join(" ")).not.toContain("wal_level=logical");
  });

  it("keeps -c runtime args on the default profile", async () => {
    const services = await buildServicesForTest({});
    const pg = services.find((s) => s.name === "postgres");
    expect(pg?.args?.join(" ")).toContain("wal_level=logical");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/stack && pnpm vitest run src/StackBuilder.provisioned.unit.test.ts`
Expected: FAIL — `provisioned` not a known property / init service always present.

- [ ] **Step 3: Implement**

In `StackBuilder.ts`, extend the config interface:

```typescript
export interface PostgresConfig {
  readonly port?: number;
  readonly dataDir?: string;
  readonly version?: string;
  readonly autoExposeNewTables?: boolean;
  /** Data dir is a pre-initialized template clone; skip the postgres-init service. */
  readonly provisioned?: boolean;
  /** "micro": settings come from micro.conf/pod.conf inside PGDATA, not -c args. */
  readonly profile?: "default" | "micro";
}
```

In the service-assembly section, wrap the `postgres-init` push:

```typescript
if (config.postgres?.provisioned !== true) {
  services.push({ ...makePostgresInitService(postgresInitOpts), enabled: true });
}
```

In `services/postgres.ts`, thread the profile through `NativePostgresOptions` and select args:

```typescript
export interface NativePostgresOptions {
  // ...existing fields...
  readonly profile?: "default" | "micro";
}

const runtimeArgs = (profile?: "default" | "micro"): readonly string[] =>
  profile === "micro" ? [] : NATIVE_POSTGRES_RUNTIME_ARGS;

// in makePostgresService:
args: [initScript, "-p", String(opts.port), ...runtimeArgs(opts.profile)],
```

In `versions.ts`: `postgres: "17.6.1.143",`.

- [ ] **Step 4: Run to verify pass, plus existing suites**

Run: `cd packages/stack && pnpm vitest run src/StackBuilder.provisioned.unit.test.ts && pnpm vitest run --exclude '**/*.e2e.test.ts'`
Expected: new tests pass; no regressions in unit/integration suites.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src packages/stack/tests
git commit -m "feat(stack): provisioned data dirs, micro profile wiring, postgres 17.6.1.143"
```

---

### Task 5: `ensureExtensionPreload` on the coordinator and StackHandle

**Files:**
- Modify: `packages/stack/src/StackLifecycleCoordinator.ts` (service methods, ~lines 131-171 and 518-564)
- Modify: `packages/stack/src/createStack.ts` (StackHandle interface ~line 90-111 and Promise wiring ~line 694-763)
- Modify: `packages/stack/src/index.ts` (export new types)
- Test: `packages/stack/src/extensionPreload.unit.test.ts`

**Interfaces:**
- Consumes: `PRELOAD_REQUIRED_EXTENSIONS` (Task 2), `readPreloadLibraries`/`writePreloadLibraries` (Task 3), coordinator `restartService` (existing).
- Produces:
  - Coordinator: `readonly ensureExtensionPreload: (name: string) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>`
  - `StackHandle.ensureExtensionPreload(name: string): Promise<void>`
  - Behavior: if `name` is not in `PRELOAD_REQUIRED_EXTENSIONS` → no-op (plain `CREATE EXTENSION` works). If already in pod.conf → no-op. Else append to pod.conf and `restartService("postgres")`.

- [ ] **Step 1: Write the failing test**

Test the pure decision logic separately from the Effect plumbing so it runs without postgres:

```typescript
// src/extensionPreload.unit.test.ts
import { describe, expect, it } from "vitest";
import { planExtensionPreload } from "./extensionPreload.ts";

describe("planExtensionPreload", () => {
  it("no-ops for extensions that do not need preload", () => {
    expect(planExtensionPreload("pgvector", [])).toEqual({ action: "none" });
  });
  it("no-ops when already preloaded", () => {
    expect(planExtensionPreload("pg_cron", ["pg_cron"])).toEqual({ action: "none" });
  });
  it("appends the required library otherwise", () => {
    expect(planExtensionPreload("pg_cron", ["pg_net"])).toEqual({
      action: "update",
      libraries: ["pg_net", "pg_cron"],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/stack && pnpm vitest run src/extensionPreload.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/extensionPreload.ts
import { PRELOAD_REQUIRED_EXTENSIONS } from "./micro.ts";

export type ExtensionPreloadPlan =
  | { readonly action: "none" }
  | { readonly action: "update"; readonly libraries: ReadonlyArray<string> };

export const planExtensionPreload = (
  name: string,
  currentLibraries: ReadonlyArray<string>,
): ExtensionPreloadPlan => {
  if (!PRELOAD_REQUIRED_EXTENSIONS.has(name)) return { action: "none" };
  if (currentLibraries.includes(name)) return { action: "none" };
  return { action: "update", libraries: [...currentLibraries, name] };
};
```

In `StackLifecycleCoordinator.ts`, add to the service interface and implementation (the coordinator already knows the resolved postgres `dataDir` from config):

```typescript
ensureExtensionPreload: (name: string) =>
  Effect.gen(function* () {
    const libs = yield* Effect.promise(() => readPreloadLibraries(pgDataDir));
    const plan = planExtensionPreload(name, libs);
    if (plan.action === "none") return;
    yield* Effect.promise(() => writePreloadLibraries(pgDataDir, plan.libraries));
    yield* restartServiceImpl("postgres");
  }),
```

In `createStack.ts`, add to `StackHandle` and the wiring:

```typescript
ensureExtensionPreload(name: string): Promise<void>;
// ...
ensureExtensionPreload: (name) => run(localStack.ensureExtensionPreload(name)),
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/stack && pnpm vitest run src/extensionPreload.unit.test.ts && pnpm vitest run --exclude '**/*.e2e.test.ts'`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src
git commit -m "feat(stack): configure extension preloads on demand"
```

---

### Task 6: Lazy service start behind the ApiProxy

**Files:**
- Modify: `packages/stack/src/StackBuilder.ts` (StackConfig + service `enabled` flags)
- Modify: `packages/stack/src/ApiProxy.ts` (ProxyHandlerOptions + makeProxyHandler, lines ~13-202; route table ~218-365)
- Test: `packages/stack/src/lazyServices.unit.test.ts`

**Interfaces:**
- Consumes: coordinator `startService(name)` (existing), process-compose `ServiceDef.enabled` (existing).
- Produces:
  - `StackConfig` gains `readonly lazyServices?: boolean` (default false → existing behavior).
  - When true: every service except `postgres` (and `postgres-init` when present) is built with `enabled: false`; ApiProxy's `ProxyConfig` gains `readonly ensureService?: (name: ServiceName) => Promise<void>`; each route entry declares its owning `service: ServiceName`; the handler awaits `ensureService(service)` before forwarding (idempotent, resolves immediately if running).
  - `createStack` wires `ensureService` to `startService` + `serviceReady`, memoizing in-flight starts so concurrent first requests trigger one start.

- [ ] **Step 1: Write the failing test** (route-level behavior with a fake ensureService)

```typescript
// src/lazyServices.unit.test.ts
import { describe, expect, it } from "vitest";
import { makeEnsureServiceMemo } from "./lazyServices.ts";

describe("makeEnsureServiceMemo", () => {
  it("starts a service once across concurrent calls", async () => {
    let starts = 0;
    const ensure = makeEnsureServiceMemo(async (name) => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    await Promise.all([ensure("realtime"), ensure("realtime"), ensure("realtime")]);
    expect(starts).toBe(1);
  });

  it("retries after a failed start", async () => {
    let attempt = 0;
    const ensure = makeEnsureServiceMemo(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
    });
    await expect(ensure("auth")).rejects.toThrow("boom");
    await ensure("auth"); // second attempt allowed
    expect(attempt).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/stack && pnpm vitest run src/lazyServices.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lazyServices.ts
import type { ServiceName } from "./versions.ts";

/** Memoize in-flight starts; clear on failure so the next request retries. */
export const makeEnsureServiceMemo = (
  start: (name: ServiceName) => Promise<void>,
): ((name: ServiceName) => Promise<void>) => {
  const inFlight = new Map<ServiceName, Promise<void>>();
  const done = new Set<ServiceName>();
  return (name) => {
    if (done.has(name)) return Promise.resolve();
    const existing = inFlight.get(name);
    if (existing) return existing;
    const p = start(name).then(
      () => {
        done.add(name);
        inFlight.delete(name);
      },
      (err: unknown) => {
        inFlight.delete(name);
        throw err;
      },
    );
    inFlight.set(name, p);
    return p;
  };
};
```

In `StackBuilder.ts`: add `readonly lazyServices?: boolean` to `StackConfig`; where each non-postgres service is pushed, compute `enabled: config.lazyServices === true ? false : <current value>`.

In `ApiProxy.ts`: add to `ProxyConfig` `readonly ensureService?: (name: ServiceName) => Promise<void>`; extend `ProxyHandlerOptions` with `readonly service: ServiceName`; annotate every route in the table with its service (`/auth/v1` → `"auth"`, `/rest/v1` → `"postgrest"`, `/functions/v1` → `"edge-runtime"`, `/realtime/v1` → `"realtime"`, `/storage/v1` → `"storage"`, `/pg` → `"pgmeta"`, etc. — follow the routing table); at the top of `makeProxyHandler`'s returned effect:

```typescript
if (config.ensureService) {
  yield* Effect.promise(() => config.ensureService!(opts.service));
}
```

In `createStack.ts`, when `resolved.lazyServices`, build the memo over `startService` + `waitReady` and pass it into the ApiProxy layer's `ProxyConfig`.

- [ ] **Step 4: Run to verify pass + no regressions**

Run: `cd packages/stack && pnpm vitest run src/lazyServices.unit.test.ts && pnpm vitest run --exclude '**/*.e2e.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src
git commit -m "feat(stack): lazy per-service start behind the API proxy"
```

---

### Task 7: Fleet manifest types + template cache key

**Files:**
- Create: `packages/fleet/src/PodManifest.ts`
- Test: `packages/fleet/src/PodManifest.unit.test.ts`

**Interfaces:**
- Consumes: `VersionManifest`, `ServiceName` types from `@supabase/stack`.
- Produces:
  - `interface PodManifest { readonly id: string; readonly versions: Partial<VersionManifest>; readonly services: Partial<Record<ServiceName, boolean>>; readonly flags: { readonly supautils: boolean }; readonly ports: { readonly dbPort: number; readonly apiPort: number }; readonly createdAt: string; }`
  - `templateKey(versions: Partial<VersionManifest>): string` — stable sha256-based key: same versions in any order → same key; different versions → different key.
  - `baseTemplateKey(postgresVersion: string): string` → `"pg-" + postgresVersion`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/PodManifest.unit.test.ts
import { describe, expect, it } from "vitest";
import { baseTemplateKey, templateKey } from "./PodManifest.ts";

describe("templateKey", () => {
  it("is stable across key order", () => {
    expect(templateKey({ postgres: "17.6.1.143", auth: "2.192.0" })).toBe(
      templateKey({ auth: "2.192.0", postgres: "17.6.1.143" }),
    );
  });
  it("changes when any version changes", () => {
    expect(templateKey({ postgres: "17.6.1.143", auth: "2.192.0" })).not.toBe(
      templateKey({ postgres: "17.6.1.143", auth: "2.192.1" }),
    );
  });
  it("base key is human-readable", () => {
    expect(baseTemplateKey("17.6.1.143")).toBe("pg-17.6.1.143");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && pnpm vitest run src/PodManifest.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/PodManifest.ts
import { createHash } from "node:crypto";
import type { ServiceName, VersionManifest } from "@supabase/stack";

export interface PodManifest {
  readonly id: string;
  readonly versions: Partial<VersionManifest>;
  readonly services: Partial<Record<ServiceName, boolean>>;
  readonly flags: { readonly supautils: boolean };
  readonly ports: { readonly dbPort: number; readonly apiPort: number };
  readonly createdAt: string;
}

export const baseTemplateKey = (postgresVersion: string): string =>
  `pg-${postgresVersion}`;

export const templateKey = (versions: Partial<VersionManifest>): string => {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `tuple-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
};
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && pnpm vitest run src/PodManifest.unit.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): pod manifest types and template cache keys"
```

---

### Task 8: Copy-on-write directory clone

**Files:**
- Create: `packages/fleet/src/cowClone.ts`
- Test: `packages/fleet/src/cowClone.integration.test.ts` (touches the filesystem)

**Interfaces:**
- Produces: `cloneDir(src: string, dest: string): Promise<void>` — APFS `cp -Rc` on darwin, `cp -R --reflink=auto` on linux, recursive copy fallback; `dest` must not exist; preserves file modes (postgres requires `0700` on PGDATA).

- [ ] **Step 1: Write the failing test**

```typescript
// src/cowClone.integration.test.ts
import { mkdtemp, mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneDir } from "./cowClone.ts";

describe("cloneDir", () => {
  it("clones a tree with content and modes; clones diverge", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "sub", "a.txt"), "hello");
    await chmod(src, 0o700);

    const dest = join(root, "dest");
    await cloneDir(src, dest);

    expect(await readFile(join(dest, "sub", "a.txt"), "utf8")).toBe("hello");
    expect(((await stat(dest)).mode & 0o777)).toBe(0o700);

    await writeFile(join(dest, "sub", "a.txt"), "changed");
    expect(await readFile(join(src, "sub", "a.txt"), "utf8")).toBe("hello");
  });

  it("refuses to clone onto an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "cow-test-"));
    const src = join(root, "src");
    await mkdir(src);
    const dest = join(root, "dest");
    await mkdir(dest);
    await expect(cloneDir(src, dest)).rejects.toThrow(/exists/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && pnpm vitest run src/cowClone.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/cowClone.ts
import { spawn } from "node:child_process";
import { cp, stat } from "node:fs/promises";

const run = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** Copy-on-write directory clone: APFS clonefile on macOS, reflink on Linux, plain copy fallback. */
export async function cloneDir(src: string, dest: string): Promise<void> {
  const exists = await stat(dest).then(() => true, () => false);
  if (exists) throw new Error(`cloneDir: destination already exists: ${dest}`);

  if (process.platform === "darwin") {
    if ((await run("cp", ["-Rc", src, dest])) === 0) return;
  } else if (process.platform === "linux") {
    if ((await run("cp", ["-R", "--reflink=auto", src, dest])) === 0) return;
  }
  // Fallback (non-CoW filesystems, other platforms): plain recursive copy.
  await cp(src, dest, { recursive: true, force: false, errorOnExist: true });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && pnpm vitest run src/cowClone.integration.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): copy-on-write directory clone (clonefile/reflink/copy)"
```

---

### Task 9: Persistent PortRegistry

**Files:**
- Create: `packages/fleet/src/PortRegistry.ts`
- Test: `packages/fleet/src/PortRegistry.unit.test.ts`

**Interfaces:**
- Produces a class (plain TS, JSON persistence, no Effect needed at this layer):
  - `PortRegistry.load(stateFile: string): Promise<PortRegistry>`
  - `allocate(podId: string): Promise<{ dbPort: number; apiPort: number }>` — deterministic scan from a base (default 55000), skipping assigned ports; persists after each allocation (atomic write: tmp file + rename)
  - `release(podId: string): Promise<void>`
  - `get(podId: string): { dbPort: number; apiPort: number } | undefined`
- This replaces `readReservedPorts()`'s cross-stack filesystem scan for fleet-managed pods: the registry is the single owner of the port space.

- [ ] **Step 1: Write the failing test**

```typescript
// src/PortRegistry.unit.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortRegistry } from "./PortRegistry.ts";

describe("PortRegistry", () => {
  it("allocates unique port pairs and persists them", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);
    const a = await reg.allocate("pod-a");
    const b = await reg.allocate("pod-b");
    expect(new Set([a.dbPort, a.apiPort, b.dbPort, b.apiPort]).size).toBe(4);

    const reloaded = await PortRegistry.load(file);
    expect(reloaded.get("pod-a")).toEqual(a);
    expect(reloaded.get("pod-b")).toEqual(b);
  });

  it("is idempotent per pod and reuses released ports", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);
    const a1 = await reg.allocate("pod-a");
    const a2 = await reg.allocate("pod-a");
    expect(a2).toEqual(a1);
    await reg.release("pod-a");
    expect(reg.get("pod-a")).toBeUndefined();
    const c = await reg.allocate("pod-c");
    expect(c.dbPort).toBe(a1.dbPort); // freed ports are reusable
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && pnpm vitest run src/PortRegistry.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/PortRegistry.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PodPorts {
  readonly dbPort: number;
  readonly apiPort: number;
}

interface PortState {
  readonly basePort: number;
  readonly pods: Record<string, PodPorts>;
}

const DEFAULT_BASE_PORT = 55000;

export class PortRegistry {
  private constructor(
    private readonly stateFile: string,
    private state: PortState,
  ) {}

  static async load(stateFile: string): Promise<PortRegistry> {
    const raw = await readFile(stateFile, "utf8").catch(() => undefined);
    const state: PortState =
      raw !== undefined
        ? (JSON.parse(raw) as PortState)
        : { basePort: DEFAULT_BASE_PORT, pods: {} };
    return new PortRegistry(stateFile, state);
  }

  get(podId: string): PodPorts | undefined {
    return this.state.pods[podId];
  }

  async allocate(podId: string): Promise<PodPorts> {
    const existing = this.state.pods[podId];
    if (existing) return existing;
    const used = new Set(
      Object.values(this.state.pods).flatMap((p) => [p.dbPort, p.apiPort]),
    );
    let candidate = this.state.basePort;
    const next = (): number => {
      while (used.has(candidate)) candidate += 1;
      used.add(candidate);
      return candidate;
    };
    const ports: PodPorts = { dbPort: next(), apiPort: next() };
    this.state = { ...this.state, pods: { ...this.state.pods, [podId]: ports } };
    await this.persist();
    return ports;
  }

  async release(podId: string): Promise<void> {
    const { [podId]: _, ...rest } = this.state.pods;
    this.state = { ...this.state, pods: rest };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.stateFile);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && pnpm vitest run src/PortRegistry.unit.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): persistent port registry"
```

---

### Task 10: TemplateStore — base and warm templates built via the stack itself

**Files:**
- Create: `packages/fleet/src/TemplateStore.ts`
- Test: `packages/fleet/src/TemplateStore.integration.test.ts` (spawns real postgres — needs the binary cache; skip in CI environments without it via `describe.skipIf(!process.env.FLEET_PG_TESTS)`)

**Interfaces:**
- Consumes: `createStack` from `@supabase/stack` (bun entry), `installMicroProfile` from `@supabase/stack` (export it from stack's index in this task), `cloneDir` (Task 8), `baseTemplateKey`/`templateKey` (Task 7).
- Produces:
  - `class TemplateStore` with:
    - `constructor(root: string)` — `root` = templates dir (e.g. `~/.supabase/templates`)
    - `ensureBaseTemplate(postgresVersion: string): Promise<string>` — returns template data-dir path. If absent: run a one-shot stack (`postgres` only, non-provisioned, so `postgres-init` applies baseline migrations), stop it, run `installMicroProfile(dataDir)`, move into `root/pg-<version>/data`, write `template.json` marker.
    - `ensureWarmTemplate(versions: Partial<VersionManifest>, enabledServices: ReadonlyArray<ServiceName>): Promise<string>` — clone base, boot the listed services once (services self-migrate), stop, freeze under `root/<templateKey>/data`. Falls back to base when `enabledServices` is empty.
    - `has(key: string): Promise<boolean>`
- Build must be concurrency-safe on one host: take a lockfile (`root/<key>.lock` created with `wx` flag; poll-wait if held; stale after 10min).

- [ ] **Step 1: Write the failing test**

```typescript
// src/TemplateStore.integration.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateStore } from "./TemplateStore.ts";

// Requires postgres binaries in the local cache; opt-in via env.
describe.skipIf(!process.env.FLEET_PG_TESTS)("TemplateStore", () => {
  it("builds a base template once and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "templates-"));
    const store = new TemplateStore(root);
    const first = await store.ensureBaseTemplate("17.6.1.143");
    expect(first).toContain("pg-17.6.1.143");
    // PGDATA got the micro profile
    const { readFile } = await import("node:fs/promises");
    const conf = await readFile(join(first, "postgresql.conf"), "utf8");
    expect(conf).toContain("include_if_exists = 'micro.conf'");

    const started = Date.now();
    const second = await store.ensureBaseTemplate("17.6.1.143");
    expect(second).toBe(first);
    expect(Date.now() - started).toBeLessThan(1000); // cache hit, no rebuild
  }, 300_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/TemplateStore.integration.test.ts`
Expected: FAIL — module not found. (Without the env var it must SKIP, verify that too.)

- [ ] **Step 3: Implement**

```typescript
// src/TemplateStore.ts
import { mkdir, open, rename, rm, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createStack, installMicroProfile } from "@supabase/stack/bun";
import type { ServiceName, VersionManifest } from "@supabase/stack";
import { cloneDir } from "./cowClone.ts";
import { baseTemplateKey, templateKey } from "./PodManifest.ts";

const LOCK_STALE_MS = 10 * 60 * 1000;

export class TemplateStore {
  constructor(private readonly root: string) {}

  private dataDir(key: string): string {
    return join(this.root, key, "data");
  }

  async has(key: string): Promise<boolean> {
    return stat(join(this.root, key, "template.json")).then(() => true, () => false);
  }

  async ensureBaseTemplate(postgresVersion: string): Promise<string> {
    const key = baseTemplateKey(postgresVersion);
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = join(this.root, `${key}.build`);
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true });
      // One-shot stack: postgres only, non-provisioned → postgres-init applies
      // roles/schemas/baseline migrations exactly as today.
      const stack = await createStack({
        postgres: { version: postgresVersion, dataDir: join(buildDir, "data") },
        postgrest: false, auth: false, edgeRuntime: false, realtime: false,
        storage: false, imgproxy: false, mailpit: false, pgmeta: false,
        studio: false, analytics: false, vector: false, pooler: false,
        functions: false,
      });
      await stack.start();
      await stack.ready();
      await stack.dispose(); // clean shutdown
      await installMicroProfile(join(buildDir, "data"));
      await mkdir(join(this.root, key), { recursive: true });
      await rename(join(buildDir, "data"), this.dataDir(key));
      await writeFile(
        join(this.root, key, "template.json"),
        JSON.stringify({ key, postgresVersion, builtAt: new Date().toISOString() }),
      );
      await rm(buildDir, { recursive: true, force: true });
      return this.dataDir(key);
    });
  }

  async ensureWarmTemplate(
    versions: Partial<VersionManifest>,
    enabledServices: ReadonlyArray<ServiceName>,
  ): Promise<string> {
    const pgVersion = versions.postgres;
    if (pgVersion === undefined) throw new Error("versions.postgres is required");
    const base = await this.ensureBaseTemplate(pgVersion);
    if (enabledServices.length === 0) return base;
    const key = templateKey(versions);
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = join(this.root, `${key}.build`);
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true });
      await cloneDir(base, join(buildDir, "data"));
      const stack = await createStack({
        postgres: { version: pgVersion, dataDir: join(buildDir, "data"), provisioned: true, profile: "micro" },
        // enable exactly the listed services so each self-migrates once:
        postgrest: enabledServices.includes("postgrest") ? {} : false,
        auth: enabledServices.includes("auth") ? {} : false,
        realtime: enabledServices.includes("realtime") ? {} : false,
        edgeRuntime: enabledServices.includes("edge-runtime") ? {} : false,
        storage: false, imgproxy: false, mailpit: false, pgmeta: false,
        studio: false, analytics: false, vector: false, pooler: false,
        functions: false,
      });
      await stack.start();
      await stack.ready();
      await stack.dispose();
      await mkdir(join(this.root, key), { recursive: true });
      await rename(join(buildDir, "data"), this.dataDir(key));
      await writeFile(
        join(this.root, key, "template.json"),
        JSON.stringify({ key, versions, enabledServices, builtAt: new Date().toISOString() }),
      );
      await rm(buildDir, { recursive: true, force: true });
      return this.dataDir(key);
    });
  }

  private async withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, `${key}.lock`);
    await mkdir(this.root, { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.close();
        break;
      } catch {
        const s = await stat(lockPath).catch(() => undefined);
        if (s && Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    try {
      return await body();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}
```

Also in `packages/stack/src/index.ts`, export the pgconf helpers so fleet can use them:

```typescript
export { installMicroProfile, readPreloadLibraries, writePreloadLibraries } from "./pgconf.ts";
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/TemplateStore.integration.test.ts`
Expected: PASS (first run downloads/boots postgres — allow minutes). Then without env: `pnpm vitest run src/TemplateStore.integration.test.ts` → skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src packages/stack/src/index.ts
git commit -m "feat(fleet): template store with base and warm templates"
```

---

### Task 11: PodRegistry + Provisioner (create / reset / fork / destroy)

**Files:**
- Create: `packages/fleet/src/PodRegistry.ts`
- Create: `packages/fleet/src/Provisioner.ts`
- Test: `packages/fleet/src/Provisioner.integration.test.ts`

**Interfaces:**
- Consumes: `PodManifest`/`templateKey` (Task 7), `cloneDir` (Task 8), `PortRegistry` (Task 9), `TemplateStore` (Task 10).
- Produces:
  - `class PodRegistry { constructor(podsRoot: string); read(id): Promise<PodManifest | undefined>; write(manifest): Promise<void>; list(): Promise<PodManifest[]>; remove(id): Promise<void>; podDir(id): string; dataDir(id): string; }` — manifest at `podsRoot/<id>/pod.json`.
  - `class Provisioner { constructor(opts: { templates: TemplateStore; pods: PodRegistry; ports: PortRegistry }); create(opts: { id: string; versions: Partial<VersionManifest>; services?: Partial<Record<ServiceName, boolean>>; flags?: { supautils?: boolean }; warm?: boolean }): Promise<PodManifest>; reset(id: string): Promise<void>; fork(sourceId: string, newId: string): Promise<PodManifest>; destroy(id: string): Promise<void>; }`
  - `create`: allocate ports → ensure template (warm if `warm: true`, else base) → `cloneDir(template, dataDir)` → write manifest. Rejects on duplicate id.
  - `reset`: delete `data`, re-clone from the same template. `fork`: requires source **suspended** (caller's responsibility at this layer; Fleet enforces in Task 14) → clone source's data dir + fresh ports + new manifest. `destroy`: remove pod dir, release ports.

- [ ] **Step 1: Write the failing test** (uses base template; postgres-dependent → gate like Task 10)

```typescript
// src/Provisioner.integration.test.ts
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner } from "./Provisioner.ts";
import { TemplateStore } from "./TemplateStore.ts";

const PG_VERSION = "17.6.1.143";

describe.skipIf(!process.env.FLEET_PG_TESTS)("Provisioner", () => {
  async function makeProvisioner() {
    const root = await mkdtemp(join(tmpdir(), "fleet-"));
    const templates = new TemplateStore(join(root, "templates"));
    const pods = new PodRegistry(join(root, "pods"));
    const ports = await PortRegistry.load(join(root, "fleet-state.json"));
    return { p: new Provisioner({ templates, pods, ports }), pods };
  }

  it("creates, forks, resets, destroys", async () => {
    const { p, pods } = await makeProvisioner();
    const a = await p.create({ id: "a", versions: { postgres: PG_VERSION } });
    expect(a.ports.dbPort).toBeGreaterThan(0);
    expect(await stat(join(pods.dataDir("a"), "PG_VERSION")).then(() => true)).toBe(true);

    // fork: divergence
    await writeFile(join(pods.dataDir("a"), "marker.txt"), "from-a");
    const b = await p.fork("a", "b");
    expect(b.ports.dbPort).not.toBe(a.ports.dbPort);
    await writeFile(join(pods.dataDir("b"), "marker.txt"), "from-b");
    expect(await Bun.file(join(pods.dataDir("a"), "marker.txt")).text()).toBe("from-a");

    // reset: marker disappears (re-cloned from template)
    await p.reset("a");
    expect(await stat(join(pods.dataDir("a"), "marker.txt")).then(() => true, () => false)).toBe(false);

    await p.destroy("a");
    await p.destroy("b");
    expect(await pods.list()).toEqual([]);
  }, 300_000);

  it("rejects duplicate ids", async () => {
    const { p } = await makeProvisioner();
    await p.create({ id: "dup", versions: { postgres: PG_VERSION } });
    await expect(p.create({ id: "dup", versions: { postgres: PG_VERSION } })).rejects.toThrow(/exists/);
  }, 300_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/Provisioner.integration.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```typescript
// src/PodRegistry.ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PodManifest } from "./PodManifest.ts";

export class PodRegistry {
  constructor(private readonly podsRoot: string) {}

  podDir(id: string): string {
    return join(this.podsRoot, id);
  }
  dataDir(id: string): string {
    return join(this.podsRoot, id, "data");
  }

  async read(id: string): Promise<PodManifest | undefined> {
    const raw = await readFile(join(this.podDir(id), "pod.json"), "utf8").catch(() => undefined);
    return raw === undefined ? undefined : (JSON.parse(raw) as PodManifest);
  }

  async write(manifest: PodManifest): Promise<void> {
    await mkdir(this.podDir(manifest.id), { recursive: true });
    await writeFile(join(this.podDir(manifest.id), "pod.json"), JSON.stringify(manifest, null, 2));
  }

  async list(): Promise<PodManifest[]> {
    const entries = await readdir(this.podsRoot).catch(() => [] as string[]);
    const manifests = await Promise.all(entries.map((id) => this.read(id)));
    return manifests.filter((m): m is PodManifest => m !== undefined);
  }

  async remove(id: string): Promise<void> {
    await rm(this.podDir(id), { recursive: true, force: true });
  }
}
```

```typescript
// src/Provisioner.ts
import { rm } from "node:fs/promises";
import type { ServiceName, VersionManifest } from "@supabase/stack";
import { cloneDir } from "./cowClone.ts";
import type { PodManifest } from "./PodManifest.ts";
import type { PodRegistry } from "./PodRegistry.ts";
import type { PortRegistry } from "./PortRegistry.ts";
import type { TemplateStore } from "./TemplateStore.ts";

export interface CreatePodOptions {
  readonly id: string;
  readonly versions: Partial<VersionManifest>;
  readonly services?: Partial<Record<ServiceName, boolean>>;
  readonly flags?: { readonly supautils?: boolean };
  /** Build/use a warm template (services pre-migrated). Default: base template. */
  readonly warm?: boolean;
}

export class Provisioner {
  constructor(
    private readonly deps: {
      readonly templates: TemplateStore;
      readonly pods: PodRegistry;
      readonly ports: PortRegistry;
    },
  ) {}

  async create(opts: CreatePodOptions): Promise<PodManifest> {
    const { templates, pods, ports } = this.deps;
    if ((await pods.read(opts.id)) !== undefined) {
      throw new Error(`pod already exists: ${opts.id}`);
    }
    const pgVersion = opts.versions.postgres;
    if (pgVersion === undefined) throw new Error("versions.postgres is required");
    const enabled = Object.entries(opts.services ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name as ServiceName);
    const template =
      opts.warm === true
        ? await templates.ensureWarmTemplate(opts.versions, enabled)
        : await templates.ensureBaseTemplate(pgVersion);
    const allocated = await ports.allocate(opts.id);
    await cloneDir(template, pods.dataDir(opts.id));
    const manifest: PodManifest = {
      id: opts.id,
      versions: opts.versions,
      services: opts.services ?? {},
      flags: { supautils: opts.flags?.supautils ?? false },
      ports: allocated,
      createdAt: new Date().toISOString(),
    };
    await pods.write(manifest);
    return manifest;
  }

  async reset(id: string): Promise<void> {
    const { templates, pods } = this.deps;
    const manifest = await pods.read(id);
    if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
    const pgVersion = manifest.versions.postgres;
    if (pgVersion === undefined) throw new Error(`pod ${id} has no postgres version`);
    const template = await templates.ensureBaseTemplate(pgVersion);
    await rm(pods.dataDir(id), { recursive: true, force: true });
    await cloneDir(template, pods.dataDir(id));
  }

  /** Caller must ensure the source pod is stopped/suspended first. */
  async fork(sourceId: string, newId: string): Promise<PodManifest> {
    const { pods, ports } = this.deps;
    const source = await pods.read(sourceId);
    if (source === undefined) throw new Error(`unknown pod: ${sourceId}`);
    if ((await pods.read(newId)) !== undefined) {
      throw new Error(`pod already exists: ${newId}`);
    }
    const allocated = await ports.allocate(newId);
    await cloneDir(pods.dataDir(sourceId), pods.dataDir(newId));
    const manifest: PodManifest = {
      ...source,
      id: newId,
      ports: allocated,
      createdAt: new Date().toISOString(),
    };
    await pods.write(manifest);
    return manifest;
  }

  async destroy(id: string): Promise<void> {
    const { pods, ports } = this.deps;
    await pods.remove(id);
    await ports.release(id);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/Provisioner.integration.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): pod registry and provisioner (create/reset/fork/destroy)"
```

---

### Task 12: EdgeProxy — TCP wake-proxy with traffic events

**Files:**
- Create: `packages/fleet/src/EdgeProxy.ts`
- Test: `packages/fleet/src/EdgeProxy.unit.test.ts` (uses plain TCP echo servers, no postgres)

**Interfaces:**
- Produces:

```typescript
export interface EdgeProxyEvents {
  /** Fired on connect/disconnect/bytes; IdleMonitor consumes these. */
  onActivity: (podId: string, event: "connect" | "data" | "disconnect", openConnections: number) => void;
}
export interface PodUpstream { readonly host: string; readonly port: number }
export class EdgeProxy {
  constructor(events?: Partial<EdgeProxyEvents>);
  /** Bind listenPort now and forever; `wake` is awaited per-connection to get the upstream. */
  register(podId: string, listenPort: number, wake: () => Promise<PodUpstream>): Promise<void>;
  unregister(podId: string): Promise<void>;
  openConnections(podId: string): number;
  close(): Promise<void>;
}
```

- Semantics: listener accepts immediately; each accepted socket pauses, awaits `wake()`, then splices to the upstream with `socket.pipe(upstream)` both ways. `wake` failures destroy the client socket. Activity events fire on every data chunk in either direction.

- [ ] **Step 1: Write the failing test**

```typescript
// src/EdgeProxy.unit.test.ts
import { createServer, connect, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeProxy } from "./EdgeProxy.ts";

function echoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => sock.pipe(sock));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe("EdgeProxy", () => {
  const proxies: EdgeProxy[] = [];
  afterEach(async () => {
    for (const p of proxies.splice(0)) await p.close();
  });

  it("wakes on first connection and splices bytes both ways", async () => {
    const { server, port: upstreamPort } = await echoServer();
    let wakes = 0;
    const proxy = new EdgeProxy();
    proxies.push(proxy);
    const listenPort = await freePort();
    await proxy.register("pod-a", listenPort, async () => {
      wakes += 1;
      return { host: "127.0.0.1", port: upstreamPort };
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("ping"));
      sock.on("data", (d) => { resolve(d.toString()); sock.end(); });
      sock.on("error", reject);
    });
    expect(reply).toBe("ping");
    expect(wakes).toBe(1);
    server.close();
  });

  it("tracks open connections and reports activity", async () => {
    const { server, port: upstreamPort } = await echoServer();
    const events: string[] = [];
    const proxy = new EdgeProxy({
      onActivity: (id, ev) => events.push(`${id}:${ev}`),
    });
    proxies.push(proxy);
    const listenPort = await freePort();
    await proxy.register("pod-b", listenPort, async () => ({ host: "127.0.0.1", port: upstreamPort }));

    await new Promise<void>((resolve) => {
      const sock = connect(listenPort, "127.0.0.1", () => sock.write("x"));
      sock.on("data", () => sock.end());
      sock.on("close", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain("pod-b:connect");
    expect(events).toContain("pod-b:data");
    expect(events).toContain("pod-b:disconnect");
    expect(proxy.openConnections("pod-b")).toBe(0);
    server.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && pnpm vitest run src/EdgeProxy.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/EdgeProxy.ts
import { connect, createServer, type Server, type Socket } from "node:net";

export interface PodUpstream {
  readonly host: string;
  readonly port: number;
}

export interface EdgeProxyEvents {
  onActivity: (
    podId: string,
    event: "connect" | "data" | "disconnect",
    openConnections: number,
  ) => void;
}

interface Registration {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

export class EdgeProxy {
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly events: Partial<EdgeProxyEvents> = {}) {}

  openConnections(podId: string): number {
    return this.registrations.get(podId)?.sockets.size ?? 0;
  }

  register(
    podId: string,
    listenPort: number,
    wake: () => Promise<PodUpstream>,
  ): Promise<void> {
    const sockets = new Set<Socket>();
    const emit = (event: "connect" | "data" | "disconnect") =>
      this.events.onActivity?.(podId, event, sockets.size);

    const server = createServer((client) => {
      sockets.add(client);
      client.pause();
      emit("connect");
      const cleanup = () => {
        if (sockets.delete(client)) emit("disconnect");
      };
      client.on("close", cleanup);
      client.on("error", cleanup);
      wake().then(
        (upstream) => {
          const backend = connect(upstream.port, upstream.host);
          backend.on("error", () => client.destroy());
          client.on("close", () => backend.destroy());
          backend.on("close", () => client.destroy());
          client.on("data", () => emit("data"));
          backend.on("data", () => emit("data"));
          backend.on("connect", () => {
            client.pipe(backend);
            backend.pipe(client);
            client.resume();
          });
        },
        () => client.destroy(),
      );
    });

    this.registrations.set(podId, { server, sockets });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => resolve());
    });
  }

  async unregister(podId: string): Promise<void> {
    const reg = this.registrations.get(podId);
    if (!reg) return;
    this.registrations.delete(podId);
    for (const sock of reg.sockets) sock.destroy();
    await new Promise<void>((resolve) => reg.server.close(() => resolve()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.registrations.keys()].map((id) => this.unregister(id)));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && pnpm vitest run src/EdgeProxy.unit.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): TCP wake-proxy edge with activity events"
```

---

### Task 13: IdleMonitor

**Files:**
- Create: `packages/fleet/src/IdleMonitor.ts`
- Test: `packages/fleet/src/IdleMonitor.unit.test.ts` (fake timers)

**Interfaces:**
- Consumes: activity events shape from Task 12.
- Produces:

```typescript
export class IdleMonitor {
  constructor(opts: {
    idleMs: number;
    onIdle: (podId: string) => void;
    now?: () => number;             // injectable clock for tests
    schedule?: typeof setTimeout;   // injectable timer for tests
  });
  /** Wire to EdgeProxy events: any activity resets the timer; open connections hold it. */
  recordActivity(podId: string, openConnections: number): void;
  /** Start tracking a pod (e.g. on wake). */
  track(podId: string): void;
  /** Stop tracking (on suspend/destroy). */
  untrack(podId: string): void;
}
```

- Semantics (spec: "no open external connections AND no bytes for T"): while `openConnections > 0` a pod never goes idle; when the last connection closes, the countdown starts from that moment; any activity resets it; `onIdle` fires at most once per warm period (re-armed by the next `track`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/IdleMonitor.unit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMonitor } from "./IdleMonitor.ts";

describe("IdleMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onIdle after idleMs with no connections and no activity", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(999);
    expect(idled).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(idled).toEqual(["a"]);
  });

  it("open connections hold the pod warm indefinitely", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 1); // one open connection
    vi.advanceTimersByTime(10_000);
    expect(idled).toEqual([]);
    mon.recordActivity("a", 0); // last connection closed
    vi.advanceTimersByTime(1001);
    expect(idled).toEqual(["a"]);
  });

  it("activity resets the countdown; untrack cancels", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(900);
    mon.recordActivity("a", 0); // reset
    vi.advanceTimersByTime(900);
    expect(idled).toEqual([]);
    mon.untrack("a");
    vi.advanceTimersByTime(5000);
    expect(idled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && pnpm vitest run src/IdleMonitor.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/IdleMonitor.ts
interface Tracked {
  timer: ReturnType<typeof setTimeout> | undefined;
  openConnections: number;
}

export class IdleMonitor {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly opts: {
      readonly idleMs: number;
      readonly onIdle: (podId: string) => void;
    },
  ) {}

  track(podId: string): void {
    if (!this.tracked.has(podId)) {
      this.tracked.set(podId, { timer: undefined, openConnections: 0 });
      this.arm(podId);
    }
  }

  untrack(podId: string): void {
    const entry = this.tracked.get(podId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.tracked.delete(podId);
  }

  recordActivity(podId: string, openConnections: number): void {
    const entry = this.tracked.get(podId);
    if (!entry) return;
    entry.openConnections = openConnections;
    this.arm(podId);
  }

  private arm(podId: string): void {
    const entry = this.tracked.get(podId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.openConnections > 0) return; // held warm by open connections
    entry.timer = setTimeout(() => {
      this.tracked.delete(podId);
      this.opts.onIdle(podId);
    }, this.opts.idleMs);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && pnpm vitest run src/IdleMonitor.unit.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): idle monitor with connection-aware countdown"
```

---

### Task 14: Fleet facade — wake/suspend lifecycle + startup reconciliation

**Files:**
- Create: `packages/fleet/src/Fleet.ts`
- Modify: `packages/fleet/src/index.ts` (public exports)
- Test: `packages/fleet/src/Fleet.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7–13, `createStack` + `StackHandle` from `@supabase/stack/bun`.
- Produces the package's public API:

```typescript
export interface FleetOptions {
  readonly root?: string;        // default: join(homedir(), ".supabase")
  readonly idleMs?: number;      // default: 5 * 60_000
}
export interface PodStatus {
  readonly manifest: PodManifest;
  readonly state: "suspended" | "waking" | "warm" | "suspending";
  readonly dbUrl: string;        // through the edge proxy port — stable across suspend cycles
}
export interface FleetHandle extends AsyncDisposable {
  createPod(opts: CreatePodOptions): Promise<PodStatus>;
  destroyPod(id: string): Promise<void>;
  resetPod(id: string): Promise<void>;
  forkPod(sourceId: string, newId: string): Promise<PodStatus>;
  wake(id: string): Promise<void>;
  suspend(id: string): Promise<void>;
  ensureExtensionPreload(id: string, extension: string): Promise<void>;
  listPods(): Promise<ReadonlyArray<PodStatus>>;
  dispose(): Promise<void>;
}
export function createFleet(opts?: FleetOptions): Promise<FleetHandle>;
```

- Key behaviors:
  - `createPod` registers the pod's `dbPort` on the EdgeProxy immediately (suspended pods answer the port; first connection wakes them). The pod's internal postgres listens on an ephemeral port chosen at wake time (`apiPort`-style allocation is internal); the **external** `dbPort` never changes.
  - Wake path: `wake(id)` (or first proxied connection) → `createStack({ postgres: { dataDir, provisioned: true, profile: "micro", port: <internal> }, lazyServices: true, ...services-from-manifest })` → `start()` → `serviceReady("postgres")` → IdleMonitor `track(id)`. Memoize concurrent wakes (reuse `makeEnsureServiceMemo` pattern with per-pod keys).
  - Suspend path: IdleMonitor `onIdle` → `suspend(id)` → `stack.dispose()` → drop the StackHandle → state `suspended`. EdgeProxy registration stays.
  - `forkPod`: `suspend(source)` first if warm, then `Provisioner.fork`.
  - `ensureExtensionPreload`: if warm → delegate to `StackHandle.ensureExtensionPreload`; if suspended → edit pod.conf directly via `writePreloadLibraries(dataDir, ...)` (no restart needed — next wake picks it up).
  - **Startup reconciliation:** on `createFleet`, scan `podsRoot/*/run.pid`; any live process groups from a previous daemon are terminated (SIGTERM, then SIGKILL after 5s) and their pods marked suspended. Phase 1 explicitly kills-then-wakes rather than adopting (documented deviation from the spec's adoption goal; acceptable because data is disposable and wake is ~fast — revisit in a later phase). Write `run.pid` on wake, remove on suspend.
  - `dispose()` suspends all warm pods and closes the EdgeProxy.

- [ ] **Step 1: Write the failing test**

```typescript
// src/Fleet.integration.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleet } from "./Fleet.ts";

const PG_VERSION = "17.6.1.143";

async function query(dbUrl: string, sql: string): Promise<string> {
  // Minimal client via Bun's built-in postgres support. If this suite runs under
  // Node-based vitest instead of Bun, swap for the `postgres` npm package (dev dep).
  const { SQL } = await import("bun");
  const db = new SQL(dbUrl);
  const rows = await db.unsafe(sql);
  await db.close();
  return JSON.stringify(rows);
}

describe.skipIf(!process.env.FLEET_PG_TESTS)("Fleet", () => {
  it("wake-on-connect, suspend-on-idle, fork", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-e2e-"));
    await using fleet = await createFleet({ root, idleMs: 2000 });

    const a = await fleet.createPod({ id: "a", versions: { postgres: PG_VERSION } });
    expect(a.state).toBe("suspended");

    // First connection wakes the pod transparently.
    await query(a.dbUrl, "create table t(x int); insert into t values (1)");
    const warm = (await fleet.listPods()).find((p) => p.manifest.id === "a");
    expect(warm?.state).toBe("warm");

    // Idle out (no connections) → suspended.
    await new Promise((r) => setTimeout(r, 4000));
    const idle = (await fleet.listPods()).find((p) => p.manifest.id === "a");
    expect(idle?.state).toBe("suspended");

    // Wake again on the SAME dbUrl; data survived suspend.
    expect(await query(a.dbUrl, "select x from t")).toContain("1");

    // Fork inherits data, diverges independently.
    const b = await fleet.forkPod("a", "b");
    await query(b.dbUrl, "insert into t values (2)");
    expect(await query(a.dbUrl, "select count(*)::int as n from t")).toContain("1");
    expect(await query(b.dbUrl, "select count(*)::int as n from t")).toContain("2");
  }, 600_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/Fleet.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Fleet.ts`**

```typescript
// src/Fleet.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  createStack,
  writePreloadLibraries,
  type StackHandle,
} from "@supabase/stack/bun";
import { EdgeProxy, type PodUpstream } from "./EdgeProxy.ts";
import { IdleMonitor } from "./IdleMonitor.ts";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner, type CreatePodOptions } from "./Provisioner.ts";
import { TemplateStore } from "./TemplateStore.ts";
import type { PodManifest } from "./PodManifest.ts";

export interface FleetOptions {
  readonly root?: string;
  readonly idleMs?: number;
}

export type PodState = "suspended" | "waking" | "warm" | "suspending";

export interface PodStatus {
  readonly manifest: PodManifest;
  readonly state: PodState;
  readonly dbUrl: string;
}

export interface FleetHandle extends AsyncDisposable {
  createPod(opts: CreatePodOptions): Promise<PodStatus>;
  destroyPod(id: string): Promise<void>;
  resetPod(id: string): Promise<void>;
  forkPod(sourceId: string, newId: string): Promise<PodStatus>;
  wake(id: string): Promise<void>;
  suspend(id: string): Promise<void>;
  ensureExtensionPreload(id: string, extension: string): Promise<void>;
  listPods(): Promise<ReadonlyArray<PodStatus>>;
  dispose(): Promise<void>;
}

interface WarmPod {
  readonly stack: StackHandle;
  readonly internalDbPort: number;
}

const DB_PASSWORD = "postgres"; // matches supabase CLI local-dev convention

export async function createFleet(opts: FleetOptions = {}): Promise<FleetHandle> {
  const root = opts.root ?? join(homedir(), ".supabase");
  const idleMs = opts.idleMs ?? 5 * 60_000;

  const templates = new TemplateStore(join(root, "templates"));
  const pods = new PodRegistry(join(root, "pods"));
  const ports = await PortRegistry.load(join(root, "fleet-state.json"));
  const provisioner = new Provisioner({ templates, pods, ports });

  const states = new Map<string, PodState>();
  const warm = new Map<string, WarmPod>();
  const wakesInFlight = new Map<string, Promise<PodUpstream>>();

  const monitor = new IdleMonitor({
    idleMs,
    onIdle: (podId) => {
      void suspend(podId).catch(() => {});
    },
  });

  const proxy = new EdgeProxy({
    onActivity: (podId, _event, openConnections) => {
      monitor.recordActivity(podId, openConnections);
    },
  });

  const dbUrl = (manifest: PodManifest): string =>
    `postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${manifest.ports.dbPort}/postgres`;

  async function wakeUpstream(id: string): Promise<PodUpstream> {
    const existing = warm.get(id);
    if (existing) return { host: "127.0.0.1", port: existing.internalDbPort };
    const inFlight = wakesInFlight.get(id);
    if (inFlight) return inFlight;
    const p = (async (): Promise<PodUpstream> => {
      const manifest = await pods.read(id);
      if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
      states.set(id, "waking");
      // Internal port: derive deterministically from external dbPort to stay clash-free
      // within the registry-owned range (external ports are even offsets; internal = +10000).
      const internalDbPort = manifest.ports.dbPort + 10_000;
      const stack = await createStack({
        stackRoot: join(pods.podDir(id), "stack"),
        port: manifest.ports.apiPort + 10_000,
        lazyServices: true,
        postgres: {
          dataDir: pods.dataDir(id),
          version: manifest.versions.postgres,
          port: internalDbPort,
          provisioned: true,
          profile: "micro",
        },
        postgrest: manifest.services.postgrest === true ? {} : false,
        auth: manifest.services.auth === true ? {} : false,
        realtime: manifest.services.realtime === true ? {} : false,
        edgeRuntime: manifest.services["edge-runtime"] === true ? {} : false,
        storage: false, imgproxy: false, mailpit: false, pgmeta: false,
        studio: false, analytics: false, vector: false, pooler: false,
        functions: false,
      });
      await stack.start();
      await stack.serviceReady("postgres");
      warm.set(id, { stack, internalDbPort });
      states.set(id, "warm");
      monitor.track(id);
      monitor.recordActivity(id, proxy.openConnections(id));
      await writeFile(join(pods.podDir(id), "run.pid"), String(process.pid));
      wakesInFlight.delete(id);
      return { host: "127.0.0.1", port: internalDbPort };
    })().catch((err: unknown) => {
      wakesInFlight.delete(id);
      states.set(id, "suspended");
      throw err;
    });
    wakesInFlight.set(id, p);
    return p;
  }

  async function registerEdge(manifest: PodManifest): Promise<void> {
    states.set(manifest.id, "suspended");
    await proxy.register(manifest.id, manifest.ports.dbPort, () => wakeUpstream(manifest.id));
  }

  async function suspend(id: string): Promise<void> {
    const pod = warm.get(id);
    if (!pod) return;
    states.set(id, "suspending");
    monitor.untrack(id);
    warm.delete(id);
    await pod.stack.dispose();
    await rm(join(pods.podDir(id), "run.pid"), { force: true });
    states.set(id, "suspended");
  }

  async function status(manifest: PodManifest): Promise<PodStatus> {
    return {
      manifest,
      state: states.get(manifest.id) ?? "suspended",
      dbUrl: dbUrl(manifest),
    };
  }

  // Startup reconciliation: phase 1 policy is kill-then-suspend, not adoption.
  // (Spec notes adoption as the goal; deferred — data is disposable and wake is fast.)
  for (const manifest of await pods.list()) {
    const pidRaw = await readFile(join(pods.podDir(manifest.id), "run.pid"), "utf8")
      .catch(() => undefined);
    if (pidRaw !== undefined) {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(-pid, "SIGTERM"); } catch { /* group gone */ }
        try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
      }
      await rm(join(pods.podDir(manifest.id), "run.pid"), { force: true });
    }
    await registerEdge(manifest);
  }

  const handle: FleetHandle = {
    async createPod(opts) {
      const manifest = await provisioner.create(opts);
      await registerEdge(manifest);
      return status(manifest);
    },
    async destroyPod(id) {
      await suspend(id);
      await proxy.unregister(id);
      states.delete(id);
      await provisioner.destroy(id);
    },
    async resetPod(id) {
      await suspend(id);
      await provisioner.reset(id);
    },
    async forkPod(sourceId, newId) {
      await suspend(sourceId);
      const manifest = await provisioner.fork(sourceId, newId);
      await registerEdge(manifest);
      return status(manifest);
    },
    async wake(id) {
      await wakeUpstream(id);
    },
    suspend,
    async ensureExtensionPreload(id, extension) {
      const pod = warm.get(id);
      if (pod) {
        await pod.stack.ensureExtensionPreload(extension);
        return;
      }
      const manifest = await pods.read(id);
      if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
      const { readPreloadLibraries } = await import("@supabase/stack/bun");
      const libs = await readPreloadLibraries(pods.dataDir(id));
      if (!libs.includes(extension)) {
        await writePreloadLibraries(pods.dataDir(id), [...libs, extension]);
      }
    },
    async listPods() {
      const manifests = await pods.list();
      return Promise.all(manifests.map((m) => status(m)));
    },
    async dispose() {
      for (const id of [...warm.keys()]) await suspend(id);
      await proxy.close();
    },
    async [Symbol.asyncDispose]() {
      await handle.dispose();
    },
  };
  return handle;
}
```

And `src/index.ts`:

```typescript
export { createFleet } from "./Fleet.ts";
export type { FleetHandle, FleetOptions, PodState, PodStatus } from "./Fleet.ts";
export type { CreatePodOptions } from "./Provisioner.ts";
export type { PodManifest } from "./PodManifest.ts";
export { templateKey, baseTemplateKey } from "./PodManifest.ts";
```

Note for the implementer: both warm and suspended pods use Stack's `configureExtensionPreload(dataDir, name)` module. Warm Stack handles additionally restart PostgreSQL when that module reports an update; suspended pods pick up the persisted configuration on their next wake.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run src/Fleet.integration.test.ts`
Expected: PASS (allow several minutes on first run for binary download + template build).

- [ ] **Step 5: Commit**

```bash
git add packages/fleet/src
git commit -m "feat(fleet): fleet facade with wake-on-connect and suspend-on-idle"
```

---

### Task 15: Density + lifecycle E2E and package README

**Files:**
- Create: `packages/fleet/tests/fleetDensity.e2e.test.ts`
- Create: `packages/fleet/README.md`

**Interfaces:**
- Consumes: `createFleet` (Task 14).
- Produces: the guardrail test from the spec ("Density E2E: 100 registered pods, wake a subset") scaled to CI reality, plus user-facing docs.

- [ ] **Step 1: Write the E2E test**

```typescript
// tests/fleetDensity.e2e.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleet } from "../src/Fleet.ts";

const PG_VERSION = "17.6.1.143";
const REGISTERED = Number(process.env.FLEET_E2E_PODS ?? 20); // 100+ locally, 20 in CI
const WARM = 3;

describe.skipIf(!process.env.FLEET_PG_TESTS)("fleet density", () => {
  it(`registers ${REGISTERED} pods, wakes ${WARM}, suspends cleanly`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-density-"));
    await using fleet = await createFleet({ root, idleMs: 60_000 });

    // Registration is cheap: template built once, then CoW clones.
    for (let i = 0; i < REGISTERED; i += 1) {
      await fleet.createPod({ id: `pod-${i}`, versions: { postgres: PG_VERSION } });
    }
    const all = await fleet.listPods();
    expect(all).toHaveLength(REGISTERED);
    expect(all.every((p) => p.state === "suspended")).toBe(true);

    // Distinct external ports across the whole fleet.
    const portSet = new Set(all.map((p) => p.manifest.ports.dbPort));
    expect(portSet.size).toBe(REGISTERED);

    // Wake a subset; the rest stay suspended (zero processes).
    for (let i = 0; i < WARM; i += 1) await fleet.wake(`pod-${i}`);
    const after = await fleet.listPods();
    expect(after.filter((p) => p.state === "warm")).toHaveLength(WARM);
    expect(after.filter((p) => p.state === "suspended")).toHaveLength(REGISTERED - WARM);

    // Explicit suspend brings a pod back to zero.
    await fleet.suspend("pod-0");
    const final = await fleet.listPods();
    expect(final.find((p) => p.manifest.id === "pod-0")?.state).toBe("suspended");
  }, 900_000);
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/fleet && FLEET_PG_TESTS=1 pnpm vitest run tests/fleetDensity.e2e.test.ts`
Expected: PASS. Locally, re-run once with `FLEET_E2E_PODS=100` and record wall-clock + `ps` observations in the PR description (PSS harness is a later phase; this is the smoke-level guardrail).

- [ ] **Step 3: Write README.md**

```markdown
# @supabase/fleet

Host-level daemon for running many lightweight Supabase pods in parallel:
CoW template provisioning, wake-on-connect, suspend-on-idle, instant fork.

## Quick start

​```ts
import { createFleet } from "@supabase/fleet";

const fleet = await createFleet();
const pod = await fleet.createPod({ id: "my-worktree", versions: { postgres: "17.6.1.143" } });
// pod.dbUrl is live immediately — the first connection wakes postgres (~200ms).
// After 5 idle minutes the pod suspends to zero processes; the port keeps listening.
const branch = await fleet.forkPod("my-worktree", "my-worktree-experiment");
​```

Design: `docs/specs/2026-07-07-micro-supabase-stacks-design.md`.
Phase 1 limitations: native mode (macOS/Linux) only; daemon restart kills-then-resuspends
running pods instead of adopting them; HTTP service lazy-start requires `lazyServices: true`.
```

(Remove the zero-width escapes around the code fences when writing the real file.)

- [ ] **Step 4: Full check**

Run: `cd packages/fleet && pnpm vitest run --exclude '**/*.e2e.test.ts' && cd ../stack && pnpm vitest run --exclude '**/*.e2e.test.ts'`
Expected: everything green. Also run `pnpm check:all` in both packages and fix lint/format findings.

- [ ] **Step 5: Commit**

```bash
git add packages/fleet
git commit -m "test(fleet): density e2e and package README"
```

---

## Deferred to later phases (explicitly out of Phase 1)

- Binary/Docker image optimizations (user direction: after this phase).
- CLI wiring of `supabase start/stop` onto `createFleet` (thin layer; do once fleet API settles).
- HTTP gateway host-based routing across pods + edge wake for the api port (Phase 1 wakes via the db port and per-service lazy start inside a warm pod).
- PSS/CPU benchmark harness with budget assertions in CI.
- True pod adoption across fleet-daemon restarts (Phase 1: kill-then-resuspend).
- Warm-template LRU garbage collection.
- `supautils` profile flag enforcement (manifest field exists; config plumbing later).
- Compatibility suite (`CREATE EXTENSION` sweep, dump/restore round-trip).
```
