# Architecture of `@supabase/stack`

Manages a local Supabase development stack — resolving native binaries, wiring services into a dependency graph, and exposing a single async `createStack()` call that returns running connection details.

## Table of contents

- [High-level overview](#high-level-overview)
- [Relationship to process-compose](#relationship-to-process-compose)
- [Components](#components)
  - [errors — typed error hierarchy](#errors--typed-error-hierarchy)
  - [Platform — OS and architecture detection](#platform--os-and-architecture-detection)
  - [BinaryResolver — download and cache binaries](#binaryresolver--download-and-cache-binaries)
  - [resolveService — binary-first Docker fallback](#resolveservice--binary-first-docker-fallback)
  - [JwtGenerator — JWT token generation and opaque keys](#jwtgenerator--jwt-token-generation-and-opaque-keys)
  - [PortAllocator — dynamic port assignment](#portallocator--dynamic-port-assignment)
  - [prefetch — pre-download binaries and images](#prefetch--pre-download-binaries-and-images)
  - [ApiProxy — reverse proxy with key translation](#apiproxy--reverse-proxy-with-key-translation)
  - [services — ServiceDef factories](#services--servicedef-factories)
  - [StackBuilder — assemble the dependency graph](#stackbuilder--assemble-the-dependency-graph)
  - [StackLifecycleCoordinator — lifecycle management](#stacklifecyclecoordinator--lifecycle-management)
  - [createStack — platform-agnostic core](#createstack--platform-agnostic-core)
  - [bun.ts / node.ts — runtime implementations behind the root export](#bunts--nodets--runtime-implementations-behind-the-root-export)
- [Data flow](#data-flow)
- [Testing](#testing)

---

## High-level overview

`@supabase/stack` answers a single question: given a `StackConfig`, start a local Supabase stack and give me the URLs and keys I need to talk to it.

Behind that simple surface, startup now has three explicit phases. `StackPreparation` resolves native-vs-Docker execution, downloads binaries, and pulls Docker images. `StackBuilder` turns the prepared artifacts into a process graph and service projection. `StackLifecycleCoordinator` then starts the orchestrator, merges pre-start and runtime state into one public stream, and exposes `Downloading`, `Starting`, `Initializing`, and `Healthy` as one continuous lifecycle to callers. An `ApiProxy` sits in front of GoTrue and PostgREST, translating opaque API keys into JWTs before forwarding requests.

```mermaid
graph TB
    subgraph Input
        SC["StackConfig<br/><i>ports, versions, secrets, keys</i>"]
    end

    subgraph "@supabase/stack"
        PLT["Platform<br/><i>detect OS + arch</i>"]
        BR["BinaryResolver<br/><i>download + cache</i>"]
        PREP["StackPreparation<br/><i>resolve + fetch assets</i>"]
        JG["JwtGenerator<br/><i>sign JWT tokens + opaque keys</i>"]
        PA["PortAllocator<br/><i>allocate ports</i>"]
        AP["ApiProxy<br/><i>reverse proxy + key translation</i>"]
        SB["StackBuilder<br/><i>wire ServiceDefs</i>"]
        LC["StackLifecycleCoordinator<br/><i>prepare + runtime lifecycle</i>"]
        CS["createStack()<br/><i>resolveConfig + layer wiring</i>"]
        BUN["bun.ts<br/><i>Bun entry point</i>"]
        NODE["node.ts<br/><i>Node.js entry point</i>"]
    end

    subgraph "@supabase/process-compose"
        BG["buildGraph()<br/><i>topological sort</i>"]
        ORC["Orchestrator<br/><i>spawn + health + restart</i>"]
    end

    subgraph Output
        SI["Stack<br/><i>url, publishableKey, secretKey, dbUrl<br/>start/stop, ready, logs, status, dispose</i>"]
    end

    SC --> CS
    PLT --> BR
    BR --> PREP
    PREP --> SB
    JG --> CS
    PA --> CS
    SB --> BG
    BG --> ORC
    ORC --> LC
    LC --> CS
    AP --> CS
    BUN --> CS
    NODE --> CS
    CS --> SI
```

The package has no CLI. It is a library: callers supply a `StackConfig` object and get back a `Stack` with a rich interface including `dispose()`. When `projectDir` points at a Supabase project, the stack can use project config to serve local Edge Functions automatically. Bun and Node.js consumers import from the package root, and the export conditions select the appropriate runtime implementation from `bun.ts` or `node.ts`.

---

## Relationship to process-compose

`@supabase/stack` and `@supabase/process-compose` have a clean boundary: stack owns _what_ to run and _where_ to get it; process-compose owns _how_ to run it.

```mermaid
graph LR
    subgraph "@supabase/stack"
        direction TB
        PLAT["Platform detection"]
        BRES["Binary download + checksum"]
        SDEFS["ServiceDef construction<br/><i>postgres / postgrest / auth</i>"]
        JWTGEN["JwtGenerator<br/><i>HS256 JWT signing + opaque keys</i>"]
        PALLOC["PortAllocator<br/><i>dynamic port assignment</i>"]
        PROXY["ApiProxy<br/><i>reverse proxy + key translation</i>"]
        PREP["StackPreparation"]
        BUILD["StackBuilder"]
        COORD["StackLifecycleCoordinator"]
        CSTACK["createStack()<br/><i>resolveConfig + layer wiring</i>"]
    end

    subgraph "@supabase/process-compose"
        direction TB
        BGRAPH["buildGraph()<br/><i>validates + sorts deps</i>"]
        ORCH["Orchestrator<br/><i>spawn, health, log, restart, shutdown</i>"]
        LB["LogBuffer"]
    end

    SDEFS --> BGRAPH
    PREP --> BUILD
    BUILD --> BGRAPH
    BGRAPH --> ORCH
    JWTGEN --> CSTACK
    PALLOC --> CSTACK
    PROXY --> COORD
    COORD --> ORCH
```

| Concern                          | Owner                       |
| -------------------------------- | --------------------------- |
| OS / arch detection              | `@supabase/stack`           |
| Binary download, cache, verify   | `@supabase/stack`           |
| ServiceDef construction          | `@supabase/stack`           |
| JWT generation                   | `@supabase/stack`           |
| Opaque API key translation       | `@supabase/stack`           |
| Reverse proxy (GoTrue/PostgREST) | `@supabase/stack`           |
| Dependency graph construction    | `@supabase/process-compose` |
| Process spawning                 | `@supabase/process-compose` |
| Health checks                    | `@supabase/process-compose` |
| Log streaming                    | `@supabase/process-compose` |
| Restart policies                 | `@supabase/process-compose` |
| Graceful shutdown                | `@supabase/process-compose` |

---

## Components

### errors — typed error hierarchy

**File:** `src/errors.ts`

All Effect errors extend `Data.TaggedError`, which adds a `_tag` discriminator for type-safe pattern matching in Effect pipelines. The compiler tracks which errors each function can produce — callers know at compile time which failure modes they need to handle.

`StackError` is a plain `Error` subclass (not a tagged Effect error) that non-Effect consumers receive from `Stack` method promises. `toStackError()` maps any tagged Effect error to a `StackError` with a string `code` field.

| Error                   | Tag                       | When raised                                                |
| ----------------------- | ------------------------- | ---------------------------------------------------------- |
| `BinaryNotFoundError`   | `"BinaryNotFoundError"`   | No asset exists for the current OS/arch combination        |
| `DownloadError`         | `"DownloadError"`         | Network request fails or `tar` extraction fails            |
| `ChecksumMismatchError` | `"ChecksumMismatchError"` | Downloaded tarball does not match the published SHA-256    |
| `DockerPullError`       | `"DockerPullError"`       | Docker image pull fails (exit code != 0 or platform error) |
| `StackBuildError`       | `"StackBuildError"`       | Any failure during binary resolution or graph assembly     |
| `PortConflictError`     | `"PortConflictError"`     | Configured port is already in use (reserved for future)    |
| `PortAllocationError`   | `"PortAllocationError"`   | Failed to bind or allocate a network port                  |
| `StackError`            | n/a (plain `Error`)       | Thrown from `Stack` promise methods for non-Effect callers |

Each Effect error carries structured metadata:

```ts
class BinaryNotFoundError extends Data.TaggedError("BinaryNotFoundError")<{
  readonly service: string; // "auth"
  readonly platform: string; // "darwin-arm64"
}> {}

class ChecksumMismatchError extends Data.TaggedError("ChecksumMismatchError")<{
  readonly url: string; // the .sha256 URL
  readonly expected: string; // hex from the checksum file
  readonly actual: string; // hex computed from the downloaded bytes
}> {}
```

`StackBuildError` is the catch-all that `StackBuilder` uses to wrap errors from `BinaryResolver`. This means consumers of `StackBuilder.build()` only need to handle one error type — the root cause is attached in `cause` for debugging.

`StackError` is the boundary type for Promise consumers:

```ts
class StackError extends Error {
  readonly code: string; // e.g. "SERVICE_NOT_FOUND", "BUILD_ERROR", "DOWNLOAD_ERROR"
}

function toStackError(err: unknown): StackError;
```

---

### Platform — OS and architecture detection

**File:** `src/Platform.ts`

A thin module that reads `process.platform` and `process.arch` and maps them to the asset-name strings used in GitHub release URLs. Different services use different naming conventions in their releases, so each has its own mapping function.

```ts
interface PlatformInfo {
  readonly os: string; // "darwin" | "linux"
  readonly arch: string; // "arm64" | "x64"
}

// Reads process.platform and process.arch
export const detectPlatform: Effect.Effect<PlatformInfo>;
```

The four mapping functions return `null` for unsupported platforms — `BinaryResolver` converts `null` into a `BinaryNotFoundError`. Returning `null` rather than throwing keeps the logic pure and easy to test without an Effect context.

**Platform support matrix:**

| Service      | darwin-arm64     | linux-x64             | linux-arm64      | win32-x64        |
| ------------ | ---------------- | --------------------- | ---------------- | ---------------- |
| postgres     | `darwin-arm64`   | `linux-x64`           | `linux-arm64`    | `null` (Docker)  |
| postgrest    | `macos-aarch64`  | `linux-static-x86-64` | `ubuntu-aarch64` | `windows-x86-64` |
| auth         | `darwin-arm64`   | `x86`                 | `arm64`          | `null` (Docker)  |
| edge-runtime | `aarch64-darwin` | `x86_64-linux`        | `aarch64-linux`  | `null` (Docker)  |

When a mapping function returns `null`, `BinaryResolver` fails with `BinaryNotFoundError` and the stack can fall back to Docker in `auto` mode. Postgres has no Windows binary. PostgREST has native binaries on all supported platforms including Windows (as a `.zip` archive instead of `.tar.xz`). Auth has native macOS arm64 and Linux binaries. Edge Runtime release assets exist for macOS arm64 and Linux, but the stack currently keeps Edge Runtime on Docker while the native path is not exposed.

```mermaid
flowchart LR
    PLT["PlatformInfo\nos + arch"] --> PA["postgresAssetName()"]
    PLT --> PRA["postgrestAssetName()"]
    PLT --> AA["authAssetName()"]

    PA -->|"darwin-arm64"| PAS["darwin-arm64"]
    PA -->|"linux-x64"| PAL["linux-x64"]
    PA -->|"win32/other"| PAX["null → Docker fallback"]

    PRA -->|"darwin-arm64"| PRAS["macos-aarch64"]
    PRA -->|"linux-x64"| PRAL["linux-static-x86-64"]
    PRA -->|"win32-x64"| PRAW["windows-x86-64"]
    PRA -->|"other"| PRAX["null → BinaryNotFoundError"]

    AA -->|"linux-x64"| AAS["x86"]
    AA -->|"linux-arm64"| AAL["arm64"]
    AA -->|"darwin/win32"| AAX["null → Docker fallback"]
```

---

### BinaryResolver — download and cache binaries

**File:** `src/BinaryResolver.ts`

`BinaryResolver` is the most complex piece of the package. Given a service name and version, it locates or downloads the correct binary for the current platform, verifies its integrity, and returns a path to the extracted directory.

#### Service interface

```ts
class BinaryResolver extends ServiceMap.Service<
  BinaryResolver,
  {
    readonly resolve: (
      spec: BinarySpec,
    ) => Effect.Effect<string, BinaryNotFoundError | DownloadError | ChecksumMismatchError>;
  }
>()("local/BinaryResolver") {}

interface BinarySpec {
  readonly service: ServiceName; // "postgres" | "postgrest" | "auth"
  readonly version: string;
  readonly cacheDir?: string; // defaults to ~/.supabase/bin
}
```

#### Binary resolution flow

```mermaid
flowchart TD
    A["resolve(spec)"] --> B["detectPlatform"]
    B --> C{"assetName?"}
    C -->|"null"| D["BinaryNotFoundError"]
    C -->|"string"| E["construct cachePath"]
    E --> F{"fs.exists(cacheDir)?"}
    F -->|"yes"| G["return cacheDir"]
    F -->|"no"| H["HttpClient.get tarball from GitHub"]
    H -->|"network error"| I["DownloadError"]
    H -->|"ok"| J{"checksumUrl?"}
    J -->|"null"| L["skip verification"]
    J -->|"string"| K["HttpClient.get .sha256 file"]
    K --> M["verifyChecksum (SHA-256)"]
    M -->|"mismatch"| N["ChecksumMismatchError"]
    M -->|"ok"| L
    L --> O["fs.makeDirectory (recursive)"]
    O --> P["write _download.tar"]
    P --> Q["tar xzf/xf to cacheDir"]
    Q -->|"exitCode != 0"| R["DownloadError"]
    Q -->|"ok"| S["fs.remove _download.tar"]
    S --> G
```

#### Cache layout

The cache directory mirrors the logical identity of each binary: `<cacheDir>/<service>/<version>/<assetName>/`. Two versions of the same service coexist without conflict. The check is a simple `fs.exists` — if the directory is present, it was extracted successfully on a previous run.

```
~/.supabase/bin/
  postgres/
    17.6.1.081-cli/
      darwin-arm64/       <- extracted binary tree
        start.sh
        bin/
          postgres
  postgrest/
    14.5/
      macos-aarch64/
        postgrest
  auth/
    2.187.0/
      arm64/
        auth
```

The cache path components — `<service>/<version>/<assetName>` — are exposed as static methods (`BinaryResolver.downloadUrl`, `BinaryResolver.checksumUrl`, `BinaryResolver.cachePath`) so they can be tested without constructing the full Effect service. These static helpers are the pure core; the Effect service wraps them with the actual I/O.

#### Checksum verification

Only postgres publishes SHA-256 checksums alongside its tarballs (as `<tarball-url>.sha256`). The verifier uses `node:crypto`'s `createHash("sha256")` to hash the downloaded bytes in memory before extraction, so a corrupted download is caught before any files are written to disk.

#### Archive extraction

The download is written to a temporary file (`_download.tar` or `_download.zip`) inside the cache directory. For tarballs (`.tar.gz`, `.tar.xz`), `tar` is used with `--strip-components=1` to remove the top-level directory. For zip archives (PostgREST on Windows), `unzip` is used on Unix or `tar xf` on Windows. The `tar`/`unzip` subprocess is spawned via `ChildProcessSpawner` from `effect/unstable/process`. After extraction, the temp file is removed (errors ignored — a leftover file is harmless).

#### Layer wiring

`BinaryResolver` requires `FileSystem | Path | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner` from the environment. The HOME directory is read via `Config.string("HOME")` rather than `process.env["HOME"]` directly.

`BinaryResolver.layer` requires all four platform services from the environment. There is no `defaultLayer` — platform layers are provided at the entry point level (`bun.ts` / `node.ts`), not baked into `BinaryResolver`.

---

### resolveService — binary-first Docker fallback

**File:** `src/resolve.ts`

`resolveService` is a thin helper that wraps `BinaryResolver.resolve()` and implements the binary-first, Docker-fallback strategy used by `StackPreparation` and therefore shared by both `stack.start()` and `prefetch()`.

#### ServiceResolution type

```ts
type ServiceResolution =
  | { readonly type: "binary"; readonly path: string }
  | { readonly type: "docker"; readonly image: string };
```

This discriminated union is the canonical output of resolution: downstream code switches on `type` to pick the right service factory.

#### Resolution logic

`resolveService(resolver, service, version)` calls `resolver.resolve({ service, version })` and maps the result:

- **Success** (binary found and extracted) → `{ type: "binary", path }`.
- **`BinaryNotFoundError`** (no native asset for this OS/arch) → `{ type: "docker", image }` using the default Docker image for the service and version.
- **`DownloadError`** (network or extraction failure) → `{ type: "docker", image }` — falls back to Docker rather than hard-failing.
- **`ChecksumMismatchError`** → propagates as a real error; a tampered or corrupted download is never silently replaced by Docker.

```ts
export const resolveService = (
  resolver: BinaryResolver["Service"],
  service: ServiceName,
  version: string,
): Effect.Effect<ServiceResolution, ChecksumMismatchError> =>
  resolver.resolve({ service, version }).pipe(
    Effect.map((path): ServiceResolution => ({ type: "binary", path })),
    Effect.catchTag("BinaryNotFoundError", () =>
      Effect.succeed<ServiceResolution>({
        type: "docker",
        image: dockerImageForService(service, version),
      }),
    ),
    Effect.catchTag("DownloadError", () =>
      Effect.succeed<ServiceResolution>({
        type: "docker",
        image: dockerImageForService(service, version),
      }),
    ),
  );
```

---

### JwtGenerator — JWT token generation and opaque keys

**File:** `src/JwtGenerator.ts`

A focused service that encapsulates HS256 JWT signing. It also exports two hardcoded opaque API key constants that match the Go CLI defaults.

#### Opaque key constants

```ts
// Hardcoded opaque key defaults matching Go CLI (pkg/config/apikeys.go:19-20).
// These are client-facing keys for local dev — SDKs use these, not JWTs directly.
export const defaultPublishableKey = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
export const defaultSecretKey = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
```

These opaque keys (`publishableKey` / `secretKey`) are what callers and SDKs use. They are not JWTs. The `ApiProxy` translates them to the actual JWTs (`anonJwt` / `serviceRoleJwt`) before forwarding requests to GoTrue and PostgREST.

#### Service interface

```ts
class JwtGenerator extends ServiceMap.Service<
  JwtGenerator,
  {
    readonly generate: (secret: string, role: string) => Effect.Effect<string>;
  }
>()("local/JwtGenerator") {}
```

`generate(secret, role)` produces a signed JWT with `{ role }` as the payload claim, using HMAC-SHA256 (`node:crypto`'s `createHmac("sha256", secret)`). Tokens are set to expire 10 years from issue time — appropriate for local development use.

#### Layer

`JwtGenerator.layer` is a `Layer.succeed` with no external dependencies — it has no I/O and requires no platform services.

---

### PortAllocator — dynamic port assignment

**File:** `src/PortAllocator.ts`

`PortAllocator` resolves all port numbers before the stack starts. It supports two strategies: an explicit port requested by the caller, or a randomly assigned port from the OS.

#### Interface

```ts
export const DEFAULT_API_PORT = 54321;
export const DEFAULT_DB_PORT = 54322;

export interface PortInput {
  readonly apiPort?: number;
  readonly dbPort?: number;
  readonly authPort?: number;
  readonly postgrestPort?: number;
  readonly postgrestAdminPort?: number;
}

export interface AllocatedPorts {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly authPort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
}

export const allocatePorts = (
  input: PortInput,
): Effect.Effect<AllocatedPorts, PortAllocationError>;
```

#### Two strategies

- **Explicit port** (`input.apiPort !== undefined`) → `probeExactPort(port)`: binds the specific port on `127.0.0.1` to confirm it is available. Fails with `PortAllocationError` if the port is already in use.
- **Omitted** → `probeRandomPort(exclude)`: binds port `0` on `127.0.0.1` so the OS assigns a free port, then closes the server immediately and returns the assigned port number.

#### Collision avoidance

Allocated ports are tracked in a `Set<number>`. When `probeRandomPort` returns a port already in the set (rare but possible under concurrent allocation), it retries automatically. This prevents two services from racing to the same port.

---

### prefetch — pre-download binaries and images

**File:** `src/prefetch.ts`

`prefetch` is now a thin wrapper over `StackPreparation`. It downloads all service binaries and pulls all Docker images concurrently, so the first `createStack()` or `stack.start()` call in a test run does not stall on slow downloads.

#### Interface

```ts
export interface PrefetchOptions {
  readonly versions?: Partial<VersionManifest>;
  /** Services to prefetch. Defaults to all. */
  readonly services?: ReadonlyArray<ServiceName>;
}

export type PrefetchResult = Record<string, ServiceResolution>;

export const prefetch: (
  options?: PrefetchOptions,
) => Effect.Effect<
  PrefetchResult,
  DockerPullError | ChecksumMismatchError,
  BinaryResolver | ChildProcessSpawner
>;
```

#### How it works

For each requested service, `prefetch` delegates to `StackPreparation.prepare()`:

- If the result is `{ type: "binary" }`, the binary is already cached — nothing more to do.
- If the result is `{ type: "docker" }`, `prefetch` runs `docker pull <image>` via `ChildProcessSpawner`. A non-zero exit code or a `PlatformError` both map to `DockerPullError`.

All services are resolved and pulled concurrently (`concurrency: "unbounded"`). The returned `PrefetchResult` maps each service name to its `ServiceResolution`.

#### Typical usage — vitest globalSetup

```ts
// vitest.config.ts / globalSetup.ts
import { prefetch } from "@supabase/stack";

export async function setup() {
  await prefetch(); // downloads auto-mode assets for all services before any test runs
  await prefetch({ mode: "docker" }); // pulls Docker images for all services
}
```

Pass `versions` to pin specific versions, or `services` to fetch a subset.

---

### ApiProxy — reverse proxy with key translation

**File:** `src/ApiProxy.ts`

`ApiProxy` is a reverse proxy that sits in front of GoTrue (auth) and PostgREST (REST API). Its primary job is to translate opaque API keys (`publishableKey`, `secretKey`) into JWTs before forwarding requests to the backend services. It also handles CORS and standard proxy headers.

#### Service interface

```ts
export interface ProxyConfig {
  readonly listenPort: number;
  readonly gotruePort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly publishableKey: string; // opaque — e.g. "sb_publishable_..."
  readonly secretKey: string; // opaque — e.g. "sb_secret_..."
  readonly anonJwt: string; // internal HS256 JWT passed to GoTrue/PostgREST
  readonly serviceRoleJwt: string; // internal HS256 JWT passed to GoTrue/PostgREST
}

class ApiProxy extends ServiceMap.Service<
  ApiProxy,
  {
    readonly address: HttpServer.Address;
  }
>()("local/ApiProxy") {
  static layer: (
    config: ProxyConfig,
  ) => Layer.Layer<ApiProxy, never, HttpServer.HttpServer | HttpClient.HttpClient>;
}
```

#### Request routing

| Route pattern        | Backend           | Auth transformation |
| -------------------- | ----------------- | ------------------- |
| `GET /health`        | (local, 200 OK)   | none                |
| `/auth/v1/verify`    | GoTrue            | none (open)         |
| `/auth/v1/callback`  | GoTrue            | none (open)         |
| `/auth/v1/authorize` | GoTrue            | none (open)         |
| `/auth/v1/*`         | GoTrue            | key translation     |
| `/rest/v1/*`         | PostgREST         | key translation     |
| `/rest-admin/v1/*`   | PostgREST (admin) | none                |

#### Key translation logic

`transformAuthorization` is called for routes marked with auth transformation:

1. If `Authorization` is present and is NOT `Bearer sb_*`, pass it through (caller has a real JWT).
2. If `apikey` matches `publishableKey` → set `Authorization: Bearer <anonJwt>`.
3. If `apikey` matches `secretKey` → set `Authorization: Bearer <serviceRoleJwt>`.
4. If `apikey` is present but unrecognized → pass it through as `Authorization`.

```mermaid
flowchart TD
    REQ["Incoming request"] --> AUTH{"Authorization header<br/>not Bearer sb_*?"}
    AUTH -->|"yes"| PASS["Pass through unchanged"]
    AUTH -->|"no / missing"| KEY{"apikey header?"}
    KEY -->|"= publishableKey"| ANON["Authorization: Bearer anonJwt"]
    KEY -->|"= secretKey"| SVC["Authorization: Bearer serviceRoleJwt"]
    KEY -->|"other"| FWD["Authorization: <apikey value>"]
    KEY -->|"missing"| NONE["No Authorization header"]
    PASS --> BACKEND["Forward to backend"]
    ANON --> BACKEND
    SVC --> BACKEND
    FWD --> BACKEND
    NONE --> BACKEND
```

#### CORS handling

All responses receive standard CORS headers (`access-control-allow-origin: *`, etc.). `OPTIONS` preflight requests are intercepted globally and receive a `204 No Content` response before reaching the router — this matches the Go proxy behavior.

#### Layer requirements

`ApiProxy.layer(config)` requires `HttpServer.HttpServer | HttpClient.HttpClient`. The `HttpServer` instance is platform-provided (via `bun.ts` or `node.ts`); `HttpClient` is provided by `FetchHttpClient.layer` in `createStack.ts`.

---

### services — ServiceDef factories

**Files:** `src/services/postgres.ts`, `src/services/postgrest.ts`, `src/services/auth.ts`

Pure factory functions that construct `ServiceDef` objects for `@supabase/process-compose`. No Effect, no async — just data construction. This separation means the shape of each service definition can be tested with plain `vitest` `it()` calls without any Effect infrastructure.

#### postgres

```ts
interface PostgresServiceOptions {
  readonly binPath: string; // path to extracted binary dir (contains start.sh)
  readonly dataDir: string; // PGDATA directory
  readonly port: number;
}
```

Postgres is the foundation of the stack. It has no dependencies and uses a TCP health check (connecting to port 5432) rather than HTTP. The TCP probe is appropriate here because postgres doesn't expose an HTTP endpoint — a successful connection on the port indicates the server is accepting connections.

The start command is `${binPath}/start.sh`, not the postgres binary directly, because the supabase-postgres release includes a wrapper script that sets the correct extension paths and configuration.

Shutdown uses `SIGINT` (not the default `SIGTERM`) with a 15-second timeout. Postgres responds to `SIGINT` with a fast shutdown: it terminates connections and exits cleanly, whereas `SIGTERM` triggers a slower smart shutdown that waits for clients to disconnect.

Postgres has two factories (like auth) because there is no Windows native binary:

```ts
// Native binary — macOS and Linux
export const makePostgresService = (opts: NativePostgresOptions): ServiceDef

// Docker — fallback for Windows
export const makePostgresServiceDocker = (opts: DockerPostgresOptions): ServiceDef
```

Both share `postgresEnv()` and `postgresHealthCheck()` helpers. The Docker variant mounts the data directory as a volume (`-v dataDir:/var/lib/postgresql/data`) and publishes the configured host port to the container port.

#### postgrest

```ts
interface PostgrestServiceOptions {
  readonly binPath: string; // path to the postgrest binary
  readonly dbPort: number;
  readonly apiPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly jwtSecret: string;
}
```

PostgREST depends on postgres being `healthy` before it starts. It uses an HTTP health check on `GET /` which PostgREST serves once it has established a database connection. Key environment variables are translated directly from config options — schema lists are joined with commas because PostgREST's `PGRST_DB_SCHEMAS` expects a comma-separated string.

The anonymous role is hardcoded to `anon`: this matches the Supabase database convention where the `anon` role has limited public permissions enforced by Row Level Security.

#### auth (two factories)

Auth has two factories because the stack supports both native and Docker auth launches:

```ts
// Native binary
export const makeAuthServiceNative = (opts: NativeAuthOptions): ServiceDef

// Docker fallback
export const makeAuthServiceDocker = (opts: DockerAuthOptions): ServiceDef
```

Both factories share the `authEnv()` helper which builds the `GOTRUE_*` environment variables from the same `AuthBaseOptions`. The native factory sets `command` to the binary path; the Docker factory sets `command: "docker"` and builds `args: ["run", "--rm", ...networkArgs, ...envArgs, image]`.

Docker services reach host-native services through `host.docker.internal`. On Linux the stack adds Docker's `host-gateway` alias explicitly; Docker Desktop provides that host name on macOS and Windows. This keeps published-port behavior consistent across all supported operating systems.

Both variants use an HTTP health check on `GET /health` (the GoTrue health endpoint). Both depend on postgres being `healthy` before starting.

---

### StackBuilder — assemble the dependency graph

**File:** `src/StackBuilder.ts`

`StackBuilder` is now graph-only. Asset preparation moved out into `StackPreparation`, so
`StackBuilder` receives a `ResolvedStackConfig` plus `PreparedStackArtifacts`, constructs the
complete `ServiceDef[]` list, and passes it to `buildGraph()` from `@supabase/process-compose`.

#### Service interface

```ts
class StackBuilder extends ServiceMap.Service<
  StackBuilder,
  {
    readonly build: (
      config: ResolvedStackConfig,
      prepared: PreparedStackArtifacts,
    ) => Effect.Effect<BuildResult, StackBuildError>;
  }
>()("local/StackBuilder") {}
```

`build()` is the only method. It takes a fully resolved `ResolvedStackConfig` (all defaults applied,
ports concrete, JWTs generated) plus prepared binary / Docker resolutions and returns the graph,
public service projection metadata, and exact cleanup targets.

#### ResolvedStackConfig

`StackBuilder.build()` receives a `ResolvedStackConfig`, not the raw user-facing `StackConfig`. All resolution (port allocation, JWT generation, default application) happens in `createStack.ts` before `build()` is called:

```ts
interface ResolvedStackConfig {
  readonly jwtSecret: string;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly autoManagedDataDir: boolean;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly postgres: ResolvedPostgresConfig;
  readonly postgrest: ResolvedPostgrestConfig | false;
  readonly auth: ResolvedAuthConfig | false;
}
```

Setting `postgrest` or `auth` to `false` excludes those services entirely. Postgres is always included.

#### Build flow

```mermaid
flowchart TD
    A["StackPreparation.prepare(config)"] --> B["PreparedStackArtifacts"]
    B --> C["StackBuilder.build(config, prepared)"]
    C --> D["BuildResult"]
```

Docker vs native selection, cache probing, binary downloads, and Docker pulls now happen entirely in
`StackPreparation`. `StackBuilder` only consumes the prepared resolutions and turns them into graph
definitions plus cleanup metadata.

---

### StackLifecycleCoordinator — lifecycle management

**File:** `src/StackLifecycleCoordinator.ts`

`StackLifecycleCoordinator` is the top-level runtime coordinator. It owns the startup state machine,
drives `StackPreparation`, builds the orchestrator from `StackBuilder`, persists cleanup targets,
and exposes the unified public state stream used by both in-process and daemon-backed flows.

#### Service interface

```ts
class StackLifecycleCoordinator extends ServiceMap.Service<
  StackLifecycleCoordinator,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
    readonly stop: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("stack/StackLifecycleCoordinator") {}
```

Internally, the coordinator owns these lifecycle phases:

- `idle`
- `preparing`
- `prepared`
- `starting`
- `running`
- `stopping`
- `stopped`

Before the orchestrator exists, it publishes synthetic service states derived from config. That is
why `getAllStates()` and `allStateChanges()` can surface `Downloading` during cold-cache startup
even though no process has been spawned yet.

#### StackInfo

```ts
interface StackInfo {
  readonly url: string; // "http://127.0.0.1:<apiPort>"
  readonly dbUrl: string; // "postgresql://postgres:postgres@127.0.0.1:<dbPort>/postgres"
  readonly publishableKey: string; // opaque key for SDK consumers
  readonly secretKey: string; // opaque key for SDK consumers (privileged)
  readonly anonJwt: string; // internal HS256 JWT (role: "anon")
  readonly serviceRoleJwt: string; // internal HS256 JWT (role: "service_role")
  readonly serviceEndpoints: Readonly<Record<string, string>>;
}
```

The `url` points to the `ApiProxy` listener, not to PostgREST directly. Callers use
`publishableKey` / `secretKey` as their API keys; the proxy translates them to JWTs internally.
`StackInfo` intentionally does not include runtime cleanup details such as Docker container names.
Those are persisted separately as internal metadata after preparation/build.

#### Layer construction

```mermaid
graph TB
    subgraph "StackLifecycleCoordinator.layer(config)"
        PREP["StackPreparation.prepareEvents()<br/><i>emits Downloading + prepared artifacts</i>"]
        SB["StackBuilder.build(config, prepared)<br/><i>produces ResolvedGraph</i>"]
        LB["LogBuffer.layer<br/><i>shared between Orchestrator + coordinator</i>"]
        OL["Orchestrator.layer(graph)<br/><i>provided with shared LogBuffer</i>"]
        EP["Layer.buildWithScope(orchLayer, scope)<br/><i>scoped to coordinator scope</i>"]
        INFO["StackInfo object<br/><i>built from ResolvedStackConfig — no JWT generation needed</i>"]
        STATE["SubscriptionRef<StackServiceState[]><br/><i>authoritative public state stream</i>"]
    end

    PREP --> SB
    SB --> LB
    LB --> OL
    OL --> EP
    EP --> STATE
    STATE --> INFO
```

The `LogBuffer` is created at coordinator level and shared with the `Orchestrator`. This gives the
coordinator direct access to `logBuffer.subscribe(name)`, `logBuffer.subscribeAll()`, and
`logBuffer.history(name, limit)` — powering the `subscribeLogs`, `subscribeAllLogs`,
`logHistory`, and `logHistoryAll` methods without going through the Orchestrator.

Public status is projected in `@supabase/stack`, not exposed raw from `@supabase/process-compose`.
Helper jobs like `postgres-init` remain part of the process graph, but the public stack API hides
them and instead projects their lifecycle onto the owning service. While `postgres-init` is active,
callers see `postgres: Initializing`.

The Orchestrator layer is constructed inside `StackLifecycleCoordinator.layer` using
`Layer.buildWithScope`. This means the Orchestrator lives within the coordinator's scope: when the
runtime is disposed, the Orchestrator's scope closes, which triggers `FiberMap` to interrupt all
service fibers and run their shutdown finalizers.

#### JWT fields and key naming

The public `Stack` service is now a thin facade over `StackLifecycleCoordinator`. `StackInfo`
contains only stable user-facing connection info; exact cleanup targets are internal runtime
metadata persisted separately for crash recovery.

---

### createStack — platform-agnostic core

**File:** `src/createStack.ts`

`createStack` is the platform-agnostic core. It wires all layers, delegates to a `ManagedRuntime`, and returns a rich `Stack` interface. It takes a `PlatformFactory` parameter — a function `(apiPort: number) => PlatformLayer` — so the platform-specific HTTP server (Bun or Node.js) can be bound to the already-resolved port. Platform-specific layers (`BunHttpServer`, `NodeHttpServer`) are provided by the entry points (`bun.ts`, `node.ts`), not baked in.

`createStack` also owns `resolveConfig()`, the internal async function that turns a raw
`StackConfig` into a `ResolvedStackConfig`: it allocates ports via `PortAllocator`, generates JWTs
via `generateJwt()` from `JwtGenerator.ts`, creates an ephemeral temp directory if no `dataDir`
was specified, and applies all service config defaults.

Once the runtime is built, `stack.start()` now means:

1. prepare assets via `StackPreparation`
2. publish synthetic `Downloading` states on cache misses
3. build the orchestrator through `StackBuilder`
4. start services and wait for health through `StackLifecycleCoordinator`

#### PlatformLayer type

```ts
/**
 * The minimum set of platform services required to run a local stack.
 * Platform entry points (bun.ts, node.ts) provide layers that satisfy this type.
 */
export type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpServer.HttpServer;

export type PlatformLayer = Layer.Layer<PlatformServices>;
```

#### Stack interface

```ts
interface Stack extends AsyncDisposable {
  // Connection info
  readonly url: string; // proxy listener URL
  readonly dbUrl: string;
  readonly publishableKey: string; // opaque publishable API key for SDK consumers
  readonly secretKey: string; // opaque secret API key for privileged SDK consumers

  // Stack lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;

  // Per-service lifecycle
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;

  // Status
  getStatus(): Promise<ReadonlyArray<StackServiceState>>;
  getServiceStatus(name: string): Promise<StackServiceState>;
  statusChanges(): AsyncIterable<StackServiceState>;

  // Logs
  logs(): AsyncIterable<LogEntry>;
  serviceLogs(name: string): AsyncIterable<LogEntry>;
  logHistory(name: string, limit?: number): Promise<ReadonlyArray<LogEntry>>;

  // Readiness
  ready(opts?: ReadyOptions): Promise<void>;
  serviceReady(name: string, opts?: ReadyOptions): Promise<void>;

  // AsyncDisposable — supports `await using stack = await createStack(...)`
  [Symbol.asyncDispose](): Promise<void>;
}

async function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Promise<Stack>;
```

`Stack` implements `AsyncDisposable`, so it works with the `await using` statement in environments that support it.

All `Stack` methods that can fail throw `StackError` (not Effect tagged errors), making them straightforward to catch in non-Effect code.

#### Layer composition

```mermaid
graph BT
    subgraph "Runtime layers (bottom to top)"
        PL["PlatformLayer<br/><i>provided by bun.ts / node.ts<br/>— FileSystem, Path, ChildProcessSpawner, HttpServer</i>"]
        FH["FetchHttpClient.layer<br/><i>for BinaryResolver + ApiProxy</i>"]
        BRL["BinaryResolver.layer<br/><i>+ FetchHttpClient</i>"]
        PREP["StackPreparation.layer<br/><i>+ BinaryResolver</i>"]
        SBL["StackBuilder.layer"]
        COORD["StackLifecycleCoordinator.layer(resolvedConfig)<br/><i>+ StackPreparation + StackBuilder</i>"]
        STACK["Stack.layer(resolvedConfig)<br/><i>thin facade over coordinator</i>"]
        APL["ApiProxy.layer(proxyConfig)<br/><i>+ FetchHttpClient</i>"]
        FULL["Layer.mergeAll(Stack, ApiProxy)<br/><i>+ PlatformLayer</i>"]
    end

    PL --> FULL
    FH --> BRL
    BRL --> PREP
    PREP --> COORD
    SBL --> COORD
    COORD --> STACK
    STACK --> FULL
    FH --> APL
    APL --> FULL
```

The assembled layer is passed to `ManagedRuntime.make()`. A `ManagedRuntime` is an Effect runtime that holds an open scope — resources allocated inside the scope (like the Orchestrator's `FiberMap`) stay alive as long as the runtime is alive. Calling `runtime.dispose()` closes the scope, which triggers all finalizers and kills all spawned processes.

Streams (`statusChanges`, `logs`, `serviceLogs`) are converted to `AsyncIterable` via `Stream.toAsyncIterableWith(stream, services)`, which requires the runtime's services map for correct resource management.

---

### bun.ts / node.ts — runtime implementations behind the root export

**Files:** `src/bun.ts`, `src/node.ts`

These thin wrappers are the runtime-specific implementations selected by the package root export conditions. Each one constructs the platform-specific layer and delegates to `createStack` from `createStack.ts`.

```ts
// bun.ts
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";

export async function createStack(config?: StackConfig): Promise<Stack> {
  return createStackCore(
    config,
    (apiPort) => BunHttpServer.layer({ port: apiPort }) as unknown as PlatformLayer,
  );
}
```

```ts
// node.ts
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

export async function createStack(config?: StackConfig): Promise<Stack> {
  return createStackCore(config, (apiPort) => {
    const spawnerLayer = NodeChildProcessSpawnerLayer.pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystemLayer, NodePathLayer)),
    );
    const httpServerLayer = NodeHttpServer.layer(() => createServer(), { port: apiPort });
    return Layer.mergeAll(httpServerLayer, spawnerLayer) as unknown as PlatformLayer;
  });
}
```

Callers import from the package root:

```ts
import { createStack } from "@supabase/stack";
```

The `HttpServer` instance is configured to listen on `apiPort` — this is the port that `ApiProxy` binds to, so the proxy's listener port matches the configured API port.

---

## Data flow

End-to-end from caller to running stack:

```mermaid
graph TB
    subgraph "1. Entry"
        CS["createStack(config, platformFactory)"]
    end

    subgraph "2. Layer assembly"
        LA["ManagedRuntime.make(fullLayer)<br/><i>wires BinaryResolver → StackPreparation → StackBuilder → StackLifecycleCoordinator + ApiProxy</i>"]
    end

    subgraph "3. Asset preparation"
        DP["detectPlatform()"]
        CH["check ~/.supabase/bin cache"]
        DL["HttpClient.get GitHub release tarball"]
        PI["docker pull image when service resolves to Docker"]
        VR["verify SHA-256 (node:crypto createHash)"]
        EX["ChildProcessSpawner → tar extract to cache"]
        DS["publish synthetic Downloading states"]
    end

    subgraph "4. Graph assembly"
        SD["makePostgresService()<br/>makePostgrestService()<br/>makeAuthServiceNative/Docker()"]
        BG["buildGraph(allDefs)<br/><i>topological sort + validation</i>"]
    end

    subgraph "5. Orchestrator startup"
        OL["Orchestrator.layer(graph) + shared LogBuffer"]
        FM["FiberMap — one fiber per service"]
        DEP["Await dependency Deferreds<br/><i>postgres healthy before postgrest/auth</i>"]
        SP["ChildProcessSpawner.spawn()"]
        HC["HealthProbe running"]
    end

    subgraph "6. ApiProxy startup"
        AP["ApiProxy.layer(proxyConfig)<br/><i>binds HttpServer on apiPort</i>"]
        KT["Key translation: publishableKey → anonJwt<br/>secretKey → serviceRoleJwt"]
    end

    subgraph "7. Output"
        SI["Stack { url, publishableKey, secretKey, dbUrl,<br/>start/stop, ready, per-service, status, logs, dispose }"]
    end

    CS --> LA
    LA --> DP
    DP --> CH
    CH -->|"miss"| DL
    DL --> VR
    VR --> EX
    CH -->|"docker"| PI
    DL --> DS
    PI --> DS
    EX --> SD
    PI --> SD
    CH -->|"hit"| SD
    SD --> BG
    BG --> OL
    OL --> FM
    FM --> DEP
    DEP --> SP
    SP --> HC
    HC -->|"healthy"| AP
    AP --> KT
    KT --> SI
```

---

## Testing

### Test file table

| File                                 | Type        | What it tests                                                                                                                |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/Platform.unit.test.ts`          | Unit        | `detectPlatform`, all three asset-name mapping functions                                                                     |
| `src/BinaryResolver.unit.test.ts`    | Unit        | Static helpers: `downloadUrl`, `checksumUrl`, `cachePath`                                                                    |
| `src/services/services.unit.test.ts` | Unit        | `makePostgresService`, `makePostgresServiceDocker`, `makePostgrestService`, `makeAuthServiceNative`, `makeAuthServiceDocker` |
| `src/ApiProxy.unit.test.ts`          | Unit        | `transformAuthorization` key translation logic, CORS headers, route routing                                                  |
| `src/StackBuilder.unit.test.ts`      | Unit        | `StackBuilder.build()` with prepared artifacts and mocked platform services                                                  |
| `src/prefetch.unit.test.ts`          | Unit        | `StackPreparation` / `prefetch` cache hits, Docker fallback order, and pull behavior                                         |
| `src/Stack.unit.test.ts`             | Integration | Public `Stack` facade over `StackLifecycleCoordinator`, including pre-start `Downloading` state publication                  |
| `src/createStack.unit.test.ts`       | Unit        | Type shape assertions + missing `stackConfig` error                                                                          |
| `tests/createStack.e2e.test.ts`      | E2e         | Full stack lifecycle: health checks, auth sign up/in/out, PostgREST CRUD                                                     |
| `tests/parallelStacks.e2e.test.ts`   | E2e         | Concurrent stacks: port uniqueness, health check validation                                                                  |

### Mock patterns

The test helper in `tests/helpers/mocks.ts` follows the same factory pattern as `@supabase/process-compose`:

```ts
function mockBinaryResolver(
  opts: {
    binaries?: Record<string, string>;
    failServices?: string[];
  } = {},
) {
  const resolved: Array<{ service: string; version: string }> = [];
  // ...
  return {
    layer: Layer.succeed(BinaryResolver, {
      resolve: (spec) => {
        /* ... */
      },
    }),
    resolved, // observable state — assert after the effect runs
  };
}
```

No `vi.fn()` spies. The mock accumulates calls in a plain array; tests assert on `resolver.resolved` after the effect completes. This avoids the overhead of mock expectation setup and teardown, and makes the test read like a data transformation check rather than a spy assertion.

**Integration test example — `StackBuilder` with mocked binaries:**

```ts
it.effect("uses docker fallback when auth binary not found", () => {
  const prepared = {
    resolutions: {
      postgres: { type: "binary", path: "/tmp/postgres" },
      postgrest: { type: "binary", path: "/tmp/postgrest" },
      auth: { type: "docker", image: "public.ecr.aws/supabase/gotrue:v2.188.0-rc.15" },
    },
  };

  return Effect.gen(function* () {
    const builder = yield* StackBuilder;
    const { graph } = yield* builder.build(baseConfig, prepared);

    const authDef = graph.startOrder.find((s) => s.name === "auth");
    expect(authDef?.command).toBe("docker");
  }).pipe(Effect.provide(StackBuilder.layer));
});
```

**Integration test example — public `Stack` key naming:**

```ts
it.effect("StackInfo uses publishableKey and secretKey", () => {
  const { layer } = setupLayer(defaultConfig);

  return Effect.gen(function* () {
    const stack = yield* Stack;
    const info = yield* stack.getInfo();

    expect(info.publishableKey).toBe(defaultPublishableKey);
    expect(info.secretKey).toBe(defaultSecretKey);
    expect(info.anonJwt).toMatch(/^ey/); // base64url JWT
    expect(info.serviceRoleJwt).toMatch(/^ey/);
  }).pipe(Effect.provide(layer));
});
```

`Stack` integration tests wire the coordinator and preparation layers together via `setupLayer()`.
The exact helper in the repo also provides metadata persistence and the shared child-process
spawner; the key idea is that tests compose `Stack.layer(config)` on top of a real
`StackLifecycleCoordinator.layer(config)`.

```ts
function setupLayer(config: ResolvedStackConfig = defaultConfig) {
  const resolver = mockBinaryResolver();
  const spawner = mockChildProcessSpawner(); // from @supabase/process-compose mocks

  const preparationLayer = StackPreparation.layer.pipe(
    Layer.provide(resolver.layer),
    Layer.provide(spawner.layer),
  );
  const coordinatorLayer = StackLifecycleCoordinator.layer(config).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(preparationLayer),
    Layer.provide(StackMetadataPersistence.noop),
  );
  const layer = Stack.layer(config).pipe(Layer.provide(coordinatorLayer));

  return { layer, resolver, spawner };
}
```

The `mockChildProcessSpawner` is reused from `@supabase/process-compose`'s test helpers — it
stubs process spawning without forking real OS processes, making `Stack` / coordinator tests fast
and deterministic.
