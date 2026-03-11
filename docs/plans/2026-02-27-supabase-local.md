# @supabase/local Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `@supabase/local` package that spins up a local Supabase stack (Postgres, PostgREST, Auth) using native binaries orchestrated by `@supabase/process-compose`, with Docker fallback when no native binary exists.

**Architecture:** Binary-first local development. `BinaryResolver` downloads/caches native binaries from GitHub releases on first use. Service definition factories convert `SupabaseConfig` into `ServiceDef[]` for process-compose. `LocalStack` wires everything together, exposing both a granular Effect API (for CLI) and a simple `createStack()` Promise API (for testing).

**Tech Stack:** Effect V4, Bun, `@supabase/process-compose`, `@supabase/config`

---

## Task 1: Package Scaffold

**Files:**
- Create: `packages/local/package.json`
- Create: `packages/local/tsconfig.json`
- Create: `packages/local/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@supabase/local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "types:check": "tsgo --noEmit",
    "lint:check": "oxlint --deny-warnings",
    "lint:fix": "oxlint --deny-warnings --fix",
    "fmt:check": "oxfmt --check",
    "fmt:fix": "oxfmt",
    "knip:check": "knip-bun",
    "knip:fix": "knip-bun --fix"
  },
  "dependencies": {
    "@effect/platform-bun": "https://pkg.pr.new/Effect-TS/effect-smol/@effect/platform-bun@842a624",
    "@supabase/process-compose": "workspace:*",
    "effect": "https://pkg.pr.new/Effect-TS/effect-smol/effect@842a624"
  },
  "devDependencies": {
    "@effect/vitest": "https://pkg.pr.new/Effect-TS/effect-smol/@effect/vitest@842a624",
    "@tsconfig/bun": "catalog:",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:",
    "knip": "catalog:",
    "oxfmt": "catalog:",
    "oxlint": "catalog:",
    "oxlint-tsgolint": "catalog:",
    "vitest": "catalog:"
  },
  "knip": {
    "entry": [
      "src/**/*.test.ts",
      "tests/**/*.ts"
    ]
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json"
}
```

**Step 3: Create empty src/index.ts**

```ts
// @supabase/local — local Supabase stack management
```

**Step 4: Install dependencies**

Run: `cd /Users/jgoux/Code/supabase/dx-labs && bun install`
Expected: Dependencies resolve, no errors.

**Step 5: Verify quality checks pass**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass (types, lint, fmt, knip).

**Step 6: Commit**

```bash
git add packages/local/
git commit -m "feat(local): scaffold @supabase/local package"
```

---

## Task 2: Error Types

**Files:**
- Create: `packages/local/src/errors.ts`
- Modify: `packages/local/src/index.ts`

**Step 1: Create error types**

File: `packages/local/src/errors.ts`

```ts
import { Data } from "effect";

export class BinaryNotFoundError extends Data.TaggedError("BinaryNotFoundError")<{
  readonly service: string;
  readonly platform: string;
}> {}

export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

export class ChecksumMismatchError extends Data.TaggedError("ChecksumMismatchError")<{
  readonly url: string;
  readonly expected: string;
  readonly actual: string;
}> {}

export class StackBuildError extends Data.TaggedError("StackBuildError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class PortConflictError extends Data.TaggedError("PortConflictError")<{
  readonly port: number;
  readonly service: string;
}> {}
```

**Step 2: Export from index.ts**

File: `packages/local/src/index.ts`

```ts
export {
  BinaryNotFoundError,
  ChecksumMismatchError,
  DownloadError,
  PortConflictError,
  StackBuildError,
} from "./errors.ts";
```

**Step 3: Verify**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass.

**Step 4: Commit**

```bash
git add packages/local/src/errors.ts packages/local/src/index.ts
git commit -m "feat(local): add typed error definitions"
```

---

## Task 3: Platform Detection

**Files:**
- Create: `packages/local/src/Platform.ts`
- Create: `packages/local/src/Platform.test.ts`
- Modify: `packages/local/src/index.ts`

**Step 1: Write the failing test**

File: `packages/local/src/Platform.test.ts`

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type PlatformInfo,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
  authAssetName,
} from "./Platform.ts";

describe("detectPlatform", () => {
  it.effect("returns current platform info", () =>
    Effect.gen(function* () {
      const info = yield* detectPlatform;
      expect(info.os).toBeDefined();
      expect(info.arch).toBeDefined();
      expect(["darwin", "linux"]).toContain(info.os);
      expect(["arm64", "x64"]).toContain(info.arch);
    }),
  );
});

describe("postgresAssetName", () => {
  it("maps darwin-arm64", () => {
    expect(postgresAssetName({ os: "darwin", arch: "arm64" })).toBe("darwin-arm64");
  });

  it("maps linux-x64", () => {
    expect(postgresAssetName({ os: "linux", arch: "x64" })).toBe("linux-x64");
  });

  it("maps linux-arm64", () => {
    expect(postgresAssetName({ os: "linux", arch: "arm64" })).toBe("linux-arm64");
  });

  it("returns null for unsupported", () => {
    expect(postgresAssetName({ os: "win32", arch: "x64" })).toBeNull();
  });
});

describe("postgrestAssetName", () => {
  it("maps darwin-arm64 to macos-aarch64", () => {
    expect(postgrestAssetName({ os: "darwin", arch: "arm64" })).toBe("macos-aarch64");
  });

  it("maps linux-x64 to linux-static-x86-64", () => {
    expect(postgrestAssetName({ os: "linux", arch: "x64" })).toBe("linux-static-x86-64");
  });

  it("maps linux-arm64 to ubuntu-aarch64", () => {
    expect(postgrestAssetName({ os: "linux", arch: "arm64" })).toBe("ubuntu-aarch64");
  });

  it("returns null for unsupported", () => {
    expect(postgrestAssetName({ os: "win32", arch: "x64" })).toBeNull();
  });
});

describe("authAssetName", () => {
  it("maps linux-x64 to x86", () => {
    expect(authAssetName({ os: "linux", arch: "x64" })).toBe("x86");
  });

  it("maps linux-arm64 to arm64", () => {
    expect(authAssetName({ os: "linux", arch: "arm64" })).toBe("arm64");
  });

  it("returns null for darwin (docker fallback)", () => {
    expect(authAssetName({ os: "darwin", arch: "arm64" })).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — module `./Platform.ts` not found.

**Step 3: Write the implementation**

File: `packages/local/src/Platform.ts`

```ts
import { Effect } from "effect";

export interface PlatformInfo {
  readonly os: string;
  readonly arch: string;
}

export const detectPlatform: Effect.Effect<PlatformInfo> = Effect.sync(() => ({
  os: process.platform,
  arch: process.arch,
}));

export const postgresAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "darwin-arm64";
  if (p.os === "linux" && p.arch === "x64") return "linux-x64";
  if (p.os === "linux" && p.arch === "arm64") return "linux-arm64";
  return null;
};

export const postgrestAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "macos-aarch64";
  if (p.os === "linux" && p.arch === "x64") return "linux-static-x86-64";
  if (p.os === "linux" && p.arch === "arm64") return "ubuntu-aarch64";
  return null;
};

export const authAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "linux" && p.arch === "x64") return "x86";
  if (p.os === "linux" && p.arch === "arm64") return "arm64";
  return null;
};
```

**Step 4: Run test to verify it passes**

Run: `cd packages/local && bun run test`
Expected: All tests PASS.

**Step 5: Export from index.ts**

Add to `packages/local/src/index.ts`:

```ts
export type { PlatformInfo } from "./Platform.ts";
export {
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
  authAssetName,
} from "./Platform.ts";
```

**Step 6: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass.

**Step 7: Commit**

```bash
git add packages/local/src/Platform.ts packages/local/src/Platform.test.ts packages/local/src/index.ts
git commit -m "feat(local): add platform detection with asset name mapping"
```

---

## Task 4: Binary Resolver Service

**Files:**
- Create: `packages/local/src/BinaryResolver.ts`
- Create: `packages/local/src/BinaryResolver.test.ts`
- Modify: `packages/local/src/index.ts`

This is the most complex service. It downloads binaries from GitHub releases, verifies checksums, and extracts to a cache directory.

**Step 1: Write the failing test**

File: `packages/local/src/BinaryResolver.test.ts`

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BinaryResolver, type BinarySpec } from "./BinaryResolver.ts";
import { BinaryNotFoundError } from "./errors.ts";

// Tests for URL construction (pure functions, no downloads)
describe("BinaryResolver.downloadUrl", () => {
  it("constructs postgres URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgres",
      version: "17.6.1.081-cli",
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      "https://github.com/supabase/postgres/releases/download/v17.6.1.081-cli/supabase-postgres-v17.6.1.081-cli-darwin-arm64.tar.gz",
    );
  });

  it("constructs postgrest URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: "14.5",
      assetName: "macos-aarch64",
    });
    expect(url).toBe(
      "https://github.com/PostgREST/postgrest/releases/download/v14.5/postgrest-v14.5-macos-aarch64.tar.xz",
    );
  });

  it("constructs auth URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "auth",
      version: "2.187.0",
      assetName: "arm64",
    });
    expect(url).toBe(
      "https://github.com/supabase/auth/releases/download/v2.187.0/auth-v2.187.0-arm64.tar.gz",
    );
  });
});

describe("BinaryResolver.checksumUrl", () => {
  it("appends .sha256 for postgres", () => {
    const url = BinaryResolver.checksumUrl({
      service: "postgres",
      version: "17.6.1.081-cli",
      assetName: "darwin-arm64",
    });
    expect(url).toContain(".tar.gz.sha256");
  });
});

describe("BinaryResolver.cachePath", () => {
  it("constructs cache path", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      version: "17.6.1.081-cli",
      assetName: "darwin-arm64",
    });
    expect(path).toBe("/home/user/.supabase/bin/postgres/17.6.1.081-cli/darwin-arm64");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

File: `packages/local/src/BinaryResolver.ts`

```ts
import { Effect, Layer, ServiceMap } from "effect";
import { FileSystem, Path } from "effect/unstable/platform";
import type { PlatformInfo } from "./Platform.ts";
import {
  authAssetName,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";
import { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";

export type ServiceName = "postgres" | "postgrest" | "auth";

export interface BinarySpec {
  readonly service: ServiceName;
  readonly version: string;
  readonly cacheDir?: string;
}

interface AssetInfo {
  readonly service: ServiceName;
  readonly version: string;
  readonly assetName: string;
}

const DEFAULT_CACHE_DIR = ".supabase/bin";

const assetNameForService = (service: ServiceName, platform: PlatformInfo): string | null => {
  switch (service) {
    case "postgres":
      return postgresAssetName(platform);
    case "postgrest":
      return postgrestAssetName(platform);
    case "auth":
      return authAssetName(platform);
  }
};

const downloadUrlPatterns: Record<ServiceName, (info: AssetInfo) => string> = {
  postgres: (i) =>
    `https://github.com/supabase/postgres/releases/download/v${i.version}/supabase-postgres-v${i.version}-${i.assetName}.tar.gz`,
  postgrest: (i) =>
    `https://github.com/PostgREST/postgrest/releases/download/v${i.version}/postgrest-v${i.version}-${i.assetName}.tar.xz`,
  auth: (i) =>
    `https://github.com/supabase/auth/releases/download/v${i.version}/auth-v${i.version}-${i.assetName}.tar.gz`,
};

const checksumExtension: Record<ServiceName, string> = {
  postgres: ".sha256",
  postgrest: "", // PostgREST doesn't publish separate checksum files
  auth: "",
};

export class BinaryResolver extends ServiceMap.Service<
  BinaryResolver,
  {
    readonly resolve: (
      spec: BinarySpec,
    ) => Effect.Effect<string, BinaryNotFoundError | DownloadError | ChecksumMismatchError>;
  }
>()("local/BinaryResolver") {
  static downloadUrl(info: AssetInfo): string {
    return downloadUrlPatterns[info.service](info);
  }

  static checksumUrl(info: AssetInfo): string | null {
    const ext = checksumExtension[info.service];
    if (!ext) return null;
    return `${BinaryResolver.downloadUrl(info)}${ext}`;
  }

  static cachePath(baseDir: string, info: AssetInfo): string {
    return `${baseDir}/${info.service}/${info.version}/${info.assetName}`;
  }

  static layer: Layer.Layer<BinaryResolver, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        return {
          resolve: (spec: BinarySpec) =>
            Effect.gen(function* () {
              const platform = yield* detectPlatform;
              const assetName = assetNameForService(spec.service, platform);

              if (assetName === null) {
                return yield* new BinaryNotFoundError({
                  service: spec.service,
                  platform: `${platform.os}-${platform.arch}`,
                });
              }

              const info: AssetInfo = {
                service: spec.service,
                version: spec.version,
                assetName,
              };

              const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
              const baseDir = spec.cacheDir ?? path.join(homeDir, DEFAULT_CACHE_DIR);
              const cachedPath = BinaryResolver.cachePath(baseDir, info);

              // Check cache
              const exists = yield* fs.exists(cachedPath);
              if (exists) return cachedPath;

              // Download
              const url = BinaryResolver.downloadUrl(info);
              const response = yield* Effect.tryPromise({
                try: () => fetch(url),
                catch: (e) => new DownloadError({ url, cause: e }),
              });

              if (!response.ok) {
                return yield* new DownloadError({
                  url,
                  cause: `HTTP ${response.status}: ${response.statusText}`,
                });
              }

              const arrayBuffer = yield* Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (e) => new DownloadError({ url, cause: e }),
              });

              // Verify checksum if available
              const checksumUrl = BinaryResolver.checksumUrl(info);
              if (checksumUrl) {
                const checksumResponse = yield* Effect.tryPromise({
                  try: () => fetch(checksumUrl),
                  catch: (e) => new DownloadError({ url: checksumUrl, cause: e }),
                });

                if (checksumResponse.ok) {
                  const expectedHash = (yield* Effect.tryPromise({
                    try: () => checksumResponse.text(),
                    catch: (e) => new DownloadError({ url: checksumUrl, cause: e }),
                  })).trim().split(/\s+/)[0]!;

                  const hasher = new Bun.CryptoHasher("sha256");
                  hasher.update(new Uint8Array(arrayBuffer));
                  const actualHash = hasher.digest("hex");

                  if (actualHash !== expectedHash) {
                    return yield* new ChecksumMismatchError({
                      url,
                      expected: expectedHash,
                      actual: actualHash,
                    });
                  }
                }
              }

              // Extract to cache dir
              yield* fs.makeDirectory(cachedPath, { recursive: true });

              const tarFlag = url.endsWith(".tar.xz") ? "xf" : "xzf";
              const tempFile = path.join(cachedPath, "__download.tmp");
              yield* fs.writeFile(tempFile, new Uint8Array(arrayBuffer));

              yield* Effect.tryPromise({
                try: () =>
                  Bun.spawn(["tar", tarFlag, tempFile, "-C", cachedPath, "--strip-components=1"], {
                    stdout: "ignore",
                    stderr: "pipe",
                  }).exited,
                catch: (e) => new DownloadError({ url, cause: `Extraction failed: ${e}` }),
              });

              yield* fs.remove(tempFile);

              return cachedPath;
            }),
        };
      }),
    );
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/local && bun run test`
Expected: All tests PASS (tests only exercise pure static methods, no downloads).

**Step 5: Export from index.ts**

Add to `packages/local/src/index.ts`:

```ts
export type { BinarySpec, ServiceName } from "./BinaryResolver.ts";
export { BinaryResolver } from "./BinaryResolver.ts";
```

**Step 6: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass.

**Step 7: Commit**

```bash
git add packages/local/src/BinaryResolver.ts packages/local/src/BinaryResolver.test.ts packages/local/src/index.ts
git commit -m "feat(local): add BinaryResolver service with download, cache, and checksum verification"
```

---

## Task 5: Service Definition Factories

**Files:**
- Create: `packages/local/src/services/postgres.ts`
- Create: `packages/local/src/services/postgrest.ts`
- Create: `packages/local/src/services/auth.ts`
- Create: `packages/local/src/services/services.test.ts`

These are pure functions that take config + binary path → `ServiceDef`. Easy to test since they're just data transformations.

**Step 1: Write the failing tests**

File: `packages/local/src/services/services.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { makePostgresService } from "./postgres.ts";
import { makePostgrestService } from "./postgrest.ts";
import { makeAuthServiceNative, makeAuthServiceDocker } from "./auth.ts";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const DB_PORT = 54322;
const API_PORT = 54321;

describe("makePostgresService", () => {
  it("creates a postgres ServiceDef with correct defaults", () => {
    const def = makePostgresService({
      binPath: "/cache/postgres/17/darwin-arm64",
      dataDir: "/tmp/supabase/data",
      port: DB_PORT,
    });

    expect(def.name).toBe("postgres");
    expect(def.command).toContain("start.sh");
    expect(def.env?.PGDATA).toBe("/tmp/supabase/data");
    expect(def.env?.PGPORT).toBe("54322");
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Tcp",
      host: "127.0.0.1",
      port: DB_PORT,
    });
    expect(def.dependencies).toBeUndefined();
    expect(def.restart).toBe("unless-stopped");
  });
});

describe("makePostgrestService", () => {
  it("creates a postgrest ServiceDef depending on healthy postgres", () => {
    const def = makePostgrestService({
      binPath: "/cache/postgrest/14.5/macos-aarch64/postgrest",
      dbPort: DB_PORT,
      apiPort: API_PORT,
      schemas: ["public", "storage"],
      extraSearchPath: ["public", "extensions"],
      maxRows: 1000,
      jwtSecret: JWT_SECRET,
    });

    expect(def.name).toBe("postgrest");
    expect(def.command).toBe("/cache/postgrest/14.5/macos-aarch64/postgrest");
    expect(def.env?.PGRST_DB_URI).toContain(`127.0.0.1:${DB_PORT}`);
    expect(def.env?.PGRST_DB_SCHEMAS).toBe("public,storage");
    expect(def.env?.PGRST_SERVER_PORT).toBe("54321");
    expect(def.env?.PGRST_JWT_SECRET).toBe(JWT_SECRET);
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: API_PORT,
      path: "/",
      scheme: "http",
    });
  });
});

describe("makeAuthServiceNative", () => {
  it("creates a native auth ServiceDef depending on healthy postgres", () => {
    const def = makeAuthServiceNative({
      binPath: "/cache/auth/2.187.0/arm64/auth",
      dbPort: DB_PORT,
      authPort: 9999,
      siteUrl: "http://localhost:3000",
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
      externalUrl: `http://127.0.0.1:${API_PORT}`,
    });

    expect(def.name).toBe("auth");
    expect(def.command).toBe("/cache/auth/2.187.0/arm64/auth");
    expect(def.env?.GOTRUE_DB_DATABASE_URL).toContain(`127.0.0.1:${DB_PORT}`);
    expect(def.env?.GOTRUE_SITE_URL).toBe("http://localhost:3000");
    expect(def.env?.GOTRUE_JWT_SECRET).toBe(JWT_SECRET);
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    expect(def.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 9999,
      path: "/health",
      scheme: "http",
    });
  });
});

describe("makeAuthServiceDocker", () => {
  it("creates a docker-based auth ServiceDef", () => {
    const def = makeAuthServiceDocker({
      image: "supabase/gotrue:v2.187.0",
      dbPort: DB_PORT,
      authPort: 9999,
      siteUrl: "http://localhost:3000",
      jwtSecret: JWT_SECRET,
      jwtExpiry: 3600,
      externalUrl: `http://127.0.0.1:${API_PORT}`,
    });

    expect(def.name).toBe("auth");
    expect(def.command).toBe("docker");
    expect(def.args).toContain("run");
    expect(def.args).toContain("--rm");
    expect(def.args).toContain("--network=host");
    expect(def.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — modules not found.

**Step 3: Implement postgres factory**

File: `packages/local/src/services/postgres.ts`

```ts
import type { ServiceDef } from "@supabase/process-compose";

export interface PostgresServiceOptions {
  readonly binPath: string;
  readonly dataDir: string;
  readonly port: number;
}

export const makePostgresService = (opts: PostgresServiceOptions): ServiceDef => ({
  name: "postgres",
  command: `${opts.binPath}/start.sh`,
  env: {
    PGDATA: opts.dataDir,
    PGPORT: String(opts.port),
  },
  healthCheck: {
    probe: { _tag: "Tcp", host: "127.0.0.1", port: opts.port },
    initialDelaySeconds: 1,
    periodSeconds: 2,
    failureThreshold: 10,
  },
  shutdown: { signal: "SIGINT", timeoutSeconds: 15 },
  restart: "unless-stopped",
});
```

**Step 4: Implement postgrest factory**

File: `packages/local/src/services/postgrest.ts`

```ts
import type { ServiceDef } from "@supabase/process-compose";

export interface PostgrestServiceOptions {
  readonly binPath: string;
  readonly dbPort: number;
  readonly apiPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly jwtSecret: string;
}

export const makePostgrestService = (opts: PostgrestServiceOptions): ServiceDef => ({
  name: "postgrest",
  command: opts.binPath,
  env: {
    PGRST_DB_URI: `postgresql://postgres:postgres@127.0.0.1:${opts.dbPort}/postgres`,
    PGRST_DB_SCHEMAS: opts.schemas.join(","),
    PGRST_DB_EXTRA_SEARCH_PATH: opts.extraSearchPath.join(","),
    PGRST_DB_MAX_ROWS: String(opts.maxRows),
    PGRST_SERVER_PORT: String(opts.apiPort),
    PGRST_JWT_SECRET: opts.jwtSecret,
    PGRST_DB_ANON_ROLE: "anon",
  },
  dependencies: [{ service: "postgres", condition: "healthy" as const }],
  healthCheck: {
    probe: {
      _tag: "Http",
      host: "127.0.0.1",
      port: opts.apiPort,
      path: "/",
      scheme: "http",
    },
    periodSeconds: 2,
    failureThreshold: 5,
  },
  restart: "unless-stopped",
});
```

**Step 5: Implement auth factory (native + docker)**

File: `packages/local/src/services/auth.ts`

```ts
import type { ServiceDef } from "@supabase/process-compose";

export interface AuthServiceOptions {
  readonly dbPort: number;
  readonly authPort: number;
  readonly siteUrl: string;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
}

export interface NativeAuthOptions extends AuthServiceOptions {
  readonly binPath: string;
}

export interface DockerAuthOptions extends AuthServiceOptions {
  readonly image: string;
}

const authEnv = (opts: AuthServiceOptions): Record<string, string> => ({
  GOTRUE_DB_DATABASE_URL: `postgresql://supabase_auth_admin:postgres@127.0.0.1:${opts.dbPort}/postgres`,
  GOTRUE_DB_DRIVER: "postgres",
  GOTRUE_SITE_URL: opts.siteUrl,
  GOTRUE_JWT_SECRET: opts.jwtSecret,
  GOTRUE_JWT_EXP: String(opts.jwtExpiry),
  API_EXTERNAL_URL: opts.externalUrl,
  GOTRUE_API_HOST: "127.0.0.1",
  GOTRUE_API_PORT: String(opts.authPort),
});

const authHealthCheck = (port: number) => ({
  probe: {
    _tag: "Http" as const,
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http" as const,
  },
  periodSeconds: 2,
  failureThreshold: 5,
});

const authDependencies = [{ service: "postgres", condition: "healthy" as const }];

export const makeAuthServiceNative = (opts: NativeAuthOptions): ServiceDef => ({
  name: "auth",
  command: opts.binPath,
  env: authEnv(opts),
  dependencies: authDependencies,
  healthCheck: authHealthCheck(opts.authPort),
  restart: "unless-stopped",
});

export const makeAuthServiceDocker = (opts: DockerAuthOptions): ServiceDef => {
  const env = authEnv(opts);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  return {
    name: "auth",
    command: "docker",
    args: ["run", "--rm", "--network=host", ...envArgs, opts.image],
    dependencies: authDependencies,
    healthCheck: authHealthCheck(opts.authPort),
    restart: "unless-stopped",
  };
};
```

**Step 6: Run tests**

Run: `cd packages/local && bun run test`
Expected: All tests PASS.

**Step 7: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass.

**Step 8: Commit**

```bash
git add packages/local/src/services/
git commit -m "feat(local): add service definition factories for postgres, postgrest, and auth"
```

---

## Task 6: Stack Builder

**Files:**
- Create: `packages/local/src/StackBuilder.ts`
- Create: `packages/local/src/StackBuilder.test.ts`
- Create: `packages/local/tests/helpers/mocks.ts`
- Modify: `packages/local/src/index.ts`

**Step 1: Create mock factories for testing**

File: `packages/local/tests/helpers/mocks.ts`

```ts
import { Effect, Layer } from "effect";
import { BinaryResolver } from "../../src/BinaryResolver.ts";
import { BinaryNotFoundError } from "../../src/errors.ts";

export function mockBinaryResolver(
  opts: {
    binaries?: Record<string, string>;
    failServices?: string[];
  } = {},
) {
  const resolved: Array<{ service: string; version: string }> = [];
  const binaries = opts.binaries ?? {
    postgres: "/cache/postgres/17/darwin-arm64",
    postgrest: "/cache/postgrest/14.5/macos-aarch64",
    auth: "/cache/auth/2.187.0/arm64",
  };

  return {
    layer: Layer.succeed(BinaryResolver, {
      resolve: (spec) =>
        Effect.gen(function* () {
          if (opts.failServices?.includes(spec.service)) {
            return yield* new BinaryNotFoundError({
              service: spec.service,
              platform: "darwin-arm64",
            });
          }
          resolved.push({ service: spec.service, version: spec.version });
          const path = binaries[spec.service];
          if (!path) {
            return yield* new BinaryNotFoundError({
              service: spec.service,
              platform: "darwin-arm64",
            });
          }
          return path;
        }),
    }),
    resolved,
  };
}
```

**Step 2: Write the failing test**

File: `packages/local/src/StackBuilder.test.ts`

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { StackBuilder, type StackConfig } from "./StackBuilder.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";

const defaultConfig: StackConfig = {
  dbPort: 54322,
  apiPort: 54321,
  authPort: 9999,
  schemas: ["public", "storage", "graphql_public"],
  extraSearchPath: ["public", "extensions"],
  maxRows: 1000,
  siteUrl: "http://localhost:3000",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  externalUrl: "http://127.0.0.1:54321",
  dataDir: "/tmp/supabase/data",
  versions: {
    postgres: "17.6.1.081-cli",
    postgrest: "14.5",
    auth: "2.187.0",
  },
  authDockerImage: "supabase/gotrue:v2.187.0",
};

describe("StackBuilder", () => {
  it.effect("builds graph with all native binaries", () => {
    const resolver = mockBinaryResolver();
    const layer = StackBuilder.layer.pipe(Layer.provide(resolver.layer));

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const graph = yield* builder.build(defaultConfig);

      expect(graph.startOrder).toHaveLength(3);
      const names = graph.startOrder.map((d) => d.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");
      // Postgres must come before postgrest and auth
      expect(names.indexOf("postgres")).toBeLessThan(names.indexOf("postgrest"));
      expect(names.indexOf("postgres")).toBeLessThan(names.indexOf("auth"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker fallback when auth binary not found", () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const layer = StackBuilder.layer.pipe(Layer.provide(resolver.layer));

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const graph = yield* builder.build(defaultConfig);

      const authDef = graph.startOrder.find((d) => d.name === "auth");
      expect(authDef).toBeDefined();
      expect(authDef!.command).toBe("docker");
    }).pipe(Effect.provide(layer));
  });

  it.effect("excludes disabled services", () => {
    const resolver = mockBinaryResolver();
    const layer = StackBuilder.layer.pipe(Layer.provide(resolver.layer));

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const graph = yield* builder.build({ ...defaultConfig, exclude: ["auth"] });

      const names = graph.startOrder.map((d) => d.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgrest");
      expect(names).not.toContain("auth");
    }).pipe(Effect.provide(layer));
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — module not found.

**Step 4: Implement StackBuilder**

File: `packages/local/src/StackBuilder.ts`

```ts
import { Effect, Layer, ServiceMap } from "effect";
import { type ResolvedGraph, buildGraph } from "@supabase/process-compose";
import type { ServiceDef } from "@supabase/process-compose";
import { BinaryResolver } from "./BinaryResolver.ts";
import { BinaryNotFoundError, StackBuildError } from "./errors.ts";
import { makePostgresService } from "./services/postgres.ts";
import { makePostgrestService } from "./services/postgrest.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";

export interface StackConfig {
  readonly dbPort: number;
  readonly apiPort: number;
  readonly authPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly siteUrl: string;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
  readonly dataDir: string;
  readonly versions: {
    readonly postgres: string;
    readonly postgrest: string;
    readonly auth: string;
  };
  readonly authDockerImage: string;
  readonly exclude?: ReadonlyArray<string>;
}

export class StackBuilder extends ServiceMap.Service<
  StackBuilder,
  {
    readonly build: (
      config: StackConfig,
    ) => Effect.Effect<ResolvedGraph, StackBuildError>;
  }
>()("local/StackBuilder") {
  static layer: Layer.Layer<StackBuilder, never, BinaryResolver> = Layer.effect(
    this,
    Effect.gen(function* () {
      const resolver = yield* BinaryResolver;

      return {
        build: (config: StackConfig) =>
          Effect.gen(function* () {
            const excluded = new Set(config.exclude ?? []);
            const services: ServiceDef[] = [];

            // Postgres (always required)
            if (!excluded.has("postgres")) {
              const pgPath = yield* resolver.resolve({
                service: "postgres",
                version: config.versions.postgres,
              });
              services.push(
                makePostgresService({
                  binPath: pgPath,
                  dataDir: config.dataDir,
                  port: config.dbPort,
                }),
              );
            }

            // PostgREST
            if (!excluded.has("postgrest")) {
              const pgrPath = yield* resolver.resolve({
                service: "postgrest",
                version: config.versions.postgrest,
              });
              services.push(
                makePostgrestService({
                  binPath: `${pgrPath}/postgrest`,
                  dbPort: config.dbPort,
                  apiPort: config.apiPort,
                  schemas: config.schemas,
                  extraSearchPath: config.extraSearchPath,
                  maxRows: config.maxRows,
                  jwtSecret: config.jwtSecret,
                }),
              );
            }

            // Auth — native with Docker fallback
            if (!excluded.has("auth")) {
              const authResult = yield* resolver
                .resolve({
                  service: "auth",
                  version: config.versions.auth,
                })
                .pipe(Effect.option);

              const authOpts = {
                dbPort: config.dbPort,
                authPort: config.authPort,
                siteUrl: config.siteUrl,
                jwtSecret: config.jwtSecret,
                jwtExpiry: config.jwtExpiry,
                externalUrl: config.externalUrl,
              };

              if (authResult._tag === "Some") {
                services.push(
                  makeAuthServiceNative({
                    ...authOpts,
                    binPath: `${authResult.value}/auth`,
                  }),
                );
              } else {
                services.push(
                  makeAuthServiceDocker({
                    ...authOpts,
                    image: config.authDockerImage,
                  }),
                );
              }
            }

            const graphResult = buildGraph(services);
            if (graphResult._tag === "Left") {
              return yield* new StackBuildError({
                detail: `Failed to build service graph: ${graphResult.left}`,
              });
            }

            return graphResult.right;
          }).pipe(
            Effect.catchTag("BinaryNotFoundError", (e) =>
              Effect.fail(
                new StackBuildError({
                  detail: `No binary found for ${e.service} on ${e.platform}`,
                  cause: e,
                }),
              ),
            ),
            Effect.catchTag("DownloadError", (e) =>
              Effect.fail(
                new StackBuildError({
                  detail: `Failed to download binary from ${e.url}`,
                  cause: e,
                }),
              ),
            ),
            Effect.catchTag("ChecksumMismatchError", (e) =>
              Effect.fail(
                new StackBuildError({
                  detail: `Checksum mismatch for ${e.url}`,
                  cause: e,
                }),
              ),
            ),
          ),
      };
    }),
  );
}
```

> **Note for implementor:** The `buildGraph` function returns `Either<Error, ResolvedGraph>`. Check the actual return type in `packages/process-compose/src/DependencyGraph.ts` and adjust the error handling accordingly. It may use Effect errors instead of Either — read the source to confirm.

**Step 5: Run tests**

Run: `cd packages/local && bun run test`
Expected: All tests PASS.

**Step 6: Export from index.ts**

Add to `packages/local/src/index.ts`:

```ts
export type { StackConfig } from "./StackBuilder.ts";
export { StackBuilder } from "./StackBuilder.ts";
```

**Step 7: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`
Expected: All checks pass.

**Step 8: Commit**

```bash
git add packages/local/src/StackBuilder.ts packages/local/src/StackBuilder.test.ts packages/local/tests/ packages/local/src/index.ts
git commit -m "feat(local): add StackBuilder that wires binary resolution to service definitions"
```

---

## Task 7: LocalStack Service

**Files:**
- Create: `packages/local/src/LocalStack.ts`
- Create: `packages/local/src/LocalStack.test.ts`
- Modify: `packages/local/src/index.ts`

**Step 1: Write the failing test**

File: `packages/local/src/LocalStack.test.ts`

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LocalStack, type StackInfo } from "./LocalStack.ts";
import { StackBuilder, type StackConfig } from "./StackBuilder.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { LogBuffer, Orchestrator } from "@supabase/process-compose";

// We test that LocalStack can be constructed and its layer wires correctly.
// Actual service orchestration is tested in process-compose.

const defaultConfig: StackConfig = {
  dbPort: 54322,
  apiPort: 54321,
  authPort: 9999,
  schemas: ["public", "storage", "graphql_public"],
  extraSearchPath: ["public", "extensions"],
  maxRows: 1000,
  siteUrl: "http://localhost:3000",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  externalUrl: "http://127.0.0.1:54321",
  dataDir: "/tmp/supabase/data",
  versions: {
    postgres: "17.6.1.081-cli",
    postgrest: "14.5",
    auth: "2.187.0",
  },
  authDockerImage: "supabase/gotrue:v2.187.0",
};

describe("LocalStack", () => {
  it.effect("produces StackInfo with correct URLs and keys", () => {
    const resolver = mockBinaryResolver();
    const layer = LocalStack.layer(defaultConfig).pipe(
      Layer.provide(StackBuilder.layer),
      Layer.provide(resolver.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* LocalStack;
      const info = yield* stack.getInfo();

      expect(info.url).toBe("http://127.0.0.1:54321");
      expect(info.dbUrl).toContain("54322");
      expect(info.anonKey).toBeDefined();
      expect(info.serviceRoleKey).toBeDefined();
    }).pipe(Effect.provide(layer));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — module not found.

**Step 3: Implement LocalStack**

File: `packages/local/src/LocalStack.ts`

```ts
import { Effect, Layer, ServiceMap, Stream } from "effect";
import {
  LogBuffer,
  Orchestrator,
  type ServiceState,
  type ServiceNotFoundError,
} from "@supabase/process-compose";
import { ChildProcessSpawner } from "effect/unstable/process";
import { StackBuilder, type StackConfig } from "./StackBuilder.ts";

export interface StackInfo {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly dbUrl: string;
}

const generateJwtToken = (secret: string, role: string): string => {
  // Minimal JWT generation for local dev — HS256
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      role,
      iss: "supabase",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10, // 10 years for local dev
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const hmac = new Bun.CryptoHasher("sha256", secret);
  hmac.update(data);
  const signature = Buffer.from(hmac.digest()).toString("base64url");
  return `${data}.${signature}`;
};

export class LocalStack extends ServiceMap.Service<
  LocalStack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void>;
    readonly stop: () => Effect.Effect<void>;
    readonly restartService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly getState: (name: string) => Effect.Effect<ServiceState, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<ServiceState>;
  }
>()("local/LocalStack") {
  static layer = (
    config: StackConfig,
  ): Layer.Layer<LocalStack, never, StackBuilder | ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const builder = yield* StackBuilder;
        const graph = yield* builder.build(config);

        const orchestratorLayer = Orchestrator.layer(graph);
        const logBufferLayer = LogBuffer.layer;
        const deps = Layer.mergeAll(logBufferLayer);
        const fullLayer = orchestratorLayer.pipe(Layer.provideMerge(deps));

        // Build the orchestrator eagerly so it's ready when start() is called
        const orchestrator = yield* Effect.provide(
          Orchestrator,
          fullLayer,
        );

        const info: StackInfo = {
          url: `http://127.0.0.1:${config.apiPort}`,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
          anonKey: generateJwtToken(config.jwtSecret, "anon"),
          serviceRoleKey: generateJwtToken(config.jwtSecret, "service_role"),
        };

        return {
          getInfo: () => Effect.succeed(info),
          start: () => orchestrator.start(),
          stop: () => orchestrator.stop(),
          restartService: (name) => orchestrator.restartService(name),
          getState: (name) => orchestrator.getState(name),
          allStateChanges: () => orchestrator.allStateChanges(),
        };
      }),
    );
}
```

> **Note for implementor:** The layer wiring here is approximate. The `Orchestrator.layer` requires `ChildProcessSpawner | LogBuffer` in its environment. You'll need to check how process-compose layers compose and adjust. Look at `packages/process-compose/src/Orchestrator.e2e.test.ts` for a real example of wiring the layers. The JWT generation also needs verification — check if `Bun.CryptoHasher` supports HMAC directly or if you need `crypto.createHmac`.

**Step 4: Run tests**

Run: `cd packages/local && bun run test`
Expected: Tests should PASS (the layer construction test doesn't start real processes).

**Step 5: Export from index.ts**

Add to `packages/local/src/index.ts`:

```ts
export type { StackInfo } from "./LocalStack.ts";
export { LocalStack } from "./LocalStack.ts";
```

**Step 6: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`

**Step 7: Commit**

```bash
git add packages/local/src/LocalStack.ts packages/local/src/LocalStack.test.ts packages/local/src/index.ts
git commit -m "feat(local): add LocalStack service wiring StackBuilder + Orchestrator"
```

---

## Task 8: createStack Convenience API

**Files:**
- Create: `packages/local/src/createStack.ts`
- Create: `packages/local/src/createStack.test.ts`
- Modify: `packages/local/src/index.ts`

**Step 1: Write the failing test**

File: `packages/local/src/createStack.test.ts`

This test verifies the API shape only (no real binaries). A full e2e test will be in a later task.

```ts
import { describe, expect, it } from "vitest";
import type { Stack, CreateStackOptions } from "./createStack.ts";

describe("createStack types", () => {
  it("Stack interface has expected shape", () => {
    // Type-level test: verify the interface compiles
    const _check = (stack: Stack) => {
      const _url: string = stack.url;
      const _anonKey: string = stack.anonKey;
      const _serviceRoleKey: string = stack.serviceRoleKey;
      const _dbUrl: string = stack.dbUrl;
      const _dispose: () => Promise<void> = stack.dispose;
    };
    expect(true).toBe(true);
  });

  it("CreateStackOptions interface has expected shape", () => {
    const _check = (opts: CreateStackOptions) => {
      const _config: string = opts.config;
      const _migrations: boolean | undefined = opts.migrations;
      const _seed: string | undefined = opts.seed;
    };
    expect(true).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/local && bun run test`
Expected: FAIL — module not found.

**Step 3: Implement createStack**

File: `packages/local/src/createStack.ts`

```ts
import { Effect, Layer, ManagedRuntime } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { BunChildProcessSpawnerLayer } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import { LocalStack, type StackInfo } from "./LocalStack.ts";
import { StackBuilder, type StackConfig } from "./StackBuilder.ts";

export interface CreateStackOptions {
  readonly config: string;
  readonly migrations?: boolean;
  readonly seed?: string;
  // Direct config overrides (used when config.toml parsing is not yet implemented)
  readonly stackConfig?: StackConfig;
}

export interface Stack {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly dbUrl: string;
  readonly dispose: () => Promise<void>;
}

export async function createStack(opts: CreateStackOptions): Promise<Stack> {
  // TODO: Parse config.toml from opts.config path
  // For now, require stackConfig to be provided directly
  const stackConfig = opts.stackConfig;
  if (!stackConfig) {
    throw new Error("stackConfig is required (config.toml parsing not yet implemented)");
  }

  const binaryResolverLayer = BinaryResolver.layer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  );

  const stackBuilderLayer = StackBuilder.layer.pipe(Layer.provide(binaryResolverLayer));

  const spawnerLayer = BunChildProcessSpawnerLayer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  );

  const localStackLayer = LocalStack.layer(stackConfig).pipe(
    Layer.provide(stackBuilderLayer),
    Layer.provide(spawnerLayer),
  );

  const runtime = ManagedRuntime.make(localStackLayer);

  const info = await runtime.runPromise(
    Effect.gen(function* () {
      const stack = yield* LocalStack;
      yield* stack.start();
      return yield* stack.getInfo();
    }),
  );

  return {
    url: info.url,
    anonKey: info.anonKey,
    serviceRoleKey: info.serviceRoleKey,
    dbUrl: info.dbUrl,
    dispose: () => runtime.dispose(),
  };
}
```

> **Note for implementor:** The layer wiring with `BunFileSystem`, `BunPath`, and `BunChildProcessSpawnerLayer` needs to be verified against the actual imports in `@effect/platform-bun` and `effect/unstable/process`. Check the process-compose e2e tests for the correct import paths. The `ManagedRuntime` usage should be verified against `.repos/effect/packages/effect/src/ManagedRuntime.ts`.

**Step 4: Run tests**

Run: `cd packages/local && bun run test`
Expected: Tests PASS.

**Step 5: Export from index.ts**

Add to `packages/local/src/index.ts`:

```ts
export type { CreateStackOptions, Stack } from "./createStack.ts";
export { createStack } from "./createStack.ts";
```

**Step 6: Verify quality checks**

Run: `cd packages/local && bun run --parallel "*:check"`

**Step 7: Commit**

```bash
git add packages/local/src/createStack.ts packages/local/src/createStack.test.ts packages/local/src/index.ts
git commit -m "feat(local): add createStack() convenience API for testing"
```

---

## Task 9: CLI Start Command

**Files:**
- Create: `apps/cli/src/commands/start/start.command.ts`
- Create: `apps/cli/src/commands/start/start.handler.ts`
- Create: `apps/cli/src/commands/start/index.ts`
- Modify: `apps/cli/src/app.ts`
- Modify: `apps/cli/package.json` (add `@supabase/local` dependency)

**Step 1: Add @supabase/local dependency to CLI**

Add to `apps/cli/package.json` dependencies:

```json
"@supabase/local": "workspace:*"
```

Run: `cd /Users/jgoux/Code/supabase/dx-labs && bun install`

**Step 2: Create the handler**

File: `apps/cli/src/commands/start/start.handler.ts`

```ts
import { Effect, Stream } from "effect";
import { LocalStack } from "@supabase/local";
import { Output } from "../../services/Output.ts";
import type { StartFlags } from "./start.command.ts";

export const start = Effect.fnUntraced(function* (_flags: StartFlags) {
  const output = yield* Output;
  const stack = yield* LocalStack;

  yield* output.intro("Starting local Supabase stack...");

  yield* stack.start();
  const info = yield* stack.getInfo();

  yield* output.success("Local Supabase started", {
    api_url: info.url,
    db_url: info.dbUrl,
    anon_key: info.anonKey,
    service_role_key: info.serviceRoleKey,
  });

  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`anon key: ${info.anonKey}`);
  yield* output.info(`service_role key: ${info.serviceRoleKey}`);

  // Stream state changes until interrupted
  yield* stack
    .allStateChanges()
    .pipe(Stream.runForEach((state) => output.info(`${state.name}: ${state.status}`)));
});
```

**Step 3: Create the command definition**

File: `apps/cli/src/commands/start/start.command.ts`

```ts
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../shared/command-helpers.ts";
import { start } from "./start.handler.ts";

const flags = {
  exclude: Flag.string("exclude").pipe(
    Flag.withDescription("Services to exclude (comma-separated)"),
    Flag.optional,
  ),
  config: Flag.string("config").pipe(
    Flag.withDescription("Path to config.toml"),
    Flag.optional,
  ),
} as const;

export type StartFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const startCommand = Command.make("start", flags).pipe(
  Command.withDescription(
    "Start the local Supabase development stack.\n\n" +
      "Downloads required binaries on first use and starts Postgres, PostgREST, and Auth services.",
  ),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withHandler((flags) =>
    start(flags).pipe(Effect.withSpan("command.start"), withJsonErrorHandling),
  ),
  // Note: LocalStack layer will be provided here once wiring is finalized
);
```

**Step 4: Create the index barrel**

File: `apps/cli/src/commands/start/index.ts`

```ts
export { startCommand } from "./start.command.ts";
```

**Step 5: Wire into app.ts**

Modify `apps/cli/src/app.ts`:

```ts
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { loginCommand } from "./commands/login/index.ts";
import { startCommand } from "./commands/start/index.ts";
import { OutputFormatFlag, SkillDirFlag, SkillFlag, UsageFlag } from "./shared/global-flags.ts";
import { jsonCliOutputFormatter } from "./shared/json-formatter.ts";
import { Output } from "./services/Output.ts";

export const root = Command.make("supabase").pipe(
  Command.withSubcommands([loginCommand, startCommand]),
  Command.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const outputFormat = yield* OutputFormatFlag;
        const base = Output.layerFor(outputFormat);
        if (outputFormat === "text") return base;
        return Layer.merge(base, CliOutput.layer(jsonCliOutputFormatter()));
      }),
    ),
  ),
  Command.withGlobalFlags([OutputFormatFlag, UsageFlag, SkillFlag, SkillDirFlag]),
);

export const cli = Command.run(root, { version: "0.1.0" });
```

**Step 6: Verify quality checks on both packages**

Run: `cd packages/local && bun run --parallel "*:check"`
Run: `cd apps/cli && bun run --parallel "*:check"`

**Step 7: Commit**

```bash
git add apps/cli/src/commands/start/ apps/cli/src/app.ts apps/cli/package.json
git commit -m "feat(cli): add start command skeleton with LocalStack integration"
```

---

## Task 10: Integration Tests for Start Command

**Files:**
- Create: `apps/cli/src/commands/start/start.integration.test.ts`
- Modify: `apps/cli/tests/helpers/mocks.ts` (add LocalStack mock)

**Step 1: Add LocalStack mock factory**

Add to `apps/cli/tests/helpers/mocks.ts`:

```ts
import { LocalStack, type StackInfo } from "@supabase/local";
import { Stream } from "effect";

export function mockLocalStack(
  opts: {
    info?: Partial<StackInfo>;
    startFail?: boolean;
  } = {},
) {
  let started = false;
  let stopped = false;
  const info: StackInfo = {
    url: "http://127.0.0.1:54321",
    anonKey: "test-anon-key",
    serviceRoleKey: "test-service-role-key",
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    ...opts.info,
  };

  return {
    layer: Layer.succeed(LocalStack, {
      getInfo: () => Effect.succeed(info),
      start: () => {
        if (opts.startFail) {
          return Effect.fail(new Error("start failed"));
        }
        started = true;
        return Effect.void;
      },
      stop: () =>
        Effect.sync(() => {
          stopped = true;
        }),
      restartService: () => Effect.void,
      getState: () => Effect.succeed({ name: "postgres", status: "Healthy" } as any),
      allStateChanges: () => Stream.empty,
    }),
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    info,
  };
}
```

**Step 2: Write integration tests**

File: `apps/cli/src/commands/start/start.integration.test.ts`

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { start } from "./start.handler.ts";
import { emptyEnv, mockLocalStack, mockOutput } from "../../../tests/helpers/mocks.ts";

function setup(opts: { startFail?: boolean } = {}) {
  const stack = mockLocalStack({ startFail: opts.startFail });
  const out = mockOutput();
  const layer = Layer.mergeAll(emptyEnv(), stack.layer, out.layer);
  return { layer, stack, out };
}

describe("start handler", () => {
  it.effect("starts the stack and displays info", () => {
    const { layer, stack, out } = setup();
    return Effect.gen(function* () {
      yield* start({ exclude: undefined, config: undefined });
      expect(stack.started).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local Supabase started" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: expect.stringContaining("54321") }),
      );
    }).pipe(Effect.provide(layer));
  });
});
```

> **Note for implementor:** This is a starting point. Add more test cases for error paths, exclude flag, etc. The exact mock and handler shapes will depend on how Tasks 7-9 are implemented. Adapt as needed.

**Step 3: Run tests**

Run: `cd apps/cli && bun run test`
Expected: All tests PASS.

**Step 4: Verify quality checks**

Run: `cd apps/cli && bun run --parallel "*:check"`

**Step 5: Commit**

```bash
git add apps/cli/src/commands/start/start.integration.test.ts apps/cli/tests/helpers/mocks.ts
git commit -m "test(cli): add integration tests for start command handler"
```

---

## Task 11: Final Wiring and Verification

**Step 1: Run full quality checks on both packages**

Run: `cd packages/local && bun run --parallel "*:check" && bun run test`
Run: `cd apps/cli && bun run --parallel "*:check" && bun run test`

**Step 2: Fix any remaining issues**

Address lint, type, or test failures discovered in Step 1.

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final wiring and quality fixes for @supabase/local"
```

---

## Implementation Notes

### Key files to reference during implementation

| File | Purpose |
|------|---------|
| `packages/process-compose/src/Orchestrator.ts` | Service class pattern, layer wiring |
| `packages/process-compose/src/Orchestrator.e2e.test.ts` | How to wire BunChildProcessSpawner + LogBuffer layers |
| `packages/process-compose/src/DependencyGraph.ts` | `buildGraph()` return type and error handling |
| `packages/process-compose/src/errors.ts` | TaggedError pattern |
| `apps/cli/src/commands/login/login.command.ts` | Command definition pattern |
| `apps/cli/src/commands/login/login.handler.ts` | Handler pattern with Effect.fnUntraced |
| `apps/cli/src/commands/login/login.integration.test.ts` | Integration test pattern |
| `apps/cli/tests/helpers/mocks.ts` | Mock factory pattern |
| `.repos/effect/packages/effect/src/ServiceMap.ts` | ServiceMap.Service API |
| `.repos/effect/MIGRATION.md` | V3 → V4 migration reference |

### Things that may need adaptation during implementation

1. **`buildGraph()` return type** — might be `Effect<ResolvedGraph, CyclicDependencyError | MissingDependencyError>` instead of `Either`. Read `DependencyGraph.ts` source.
2. **Layer composition for Orchestrator** — check exactly what `ChildProcessSpawner` layer is needed. The e2e tests in process-compose show the exact wiring.
3. **JWT generation** — `Bun.CryptoHasher` may not support HMAC natively. May need `crypto.createHmac("sha256", secret)` from Node.
4. **`@effect/platform-bun` imports** — verify exact import paths for `BunFileSystem`, `BunPath`, `BunChildProcessSpawnerLayer`.
5. **Config.toml parsing** — deferred. The `createStack` API takes `stackConfig` directly for now.
