# Architecture of `@supabase/local`

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
  - [LocalStack — lifecycle management](#localstack--lifecycle-management)
  - [createStack — platform-agnostic core](#createstack--platform-agnostic-core)
  - [bun.ts / node.ts — platform entry points](#bunts--nodets--platform-entry-points)
- [Data flow](#data-flow)
- [Testing](#testing)

---

## High-level overview

`@supabase/local` answers a single question: given a `StackConfig`, start a local Supabase stack and give me the URLs and keys I need to talk to it.

Behind that simple surface, quite a lot happens. Each binary (postgres, postgrest, auth) must be resolved for the current OS and CPU architecture, downloaded from GitHub releases if not already cached, and verified. The binaries are then composed into `ServiceDef` objects and handed to `@supabase/process-compose`, which handles health checks, dependency ordering, log streaming, restart policies, and shutdown. An `ApiProxy` sits in front of GoTrue and PostgREST, translating opaque API keys into JWTs before forwarding requests.

```mermaid
graph TB
    subgraph Input
        SC["StackConfig<br/><i>ports, versions, secrets, keys</i>"]
    end

    subgraph "@supabase/local"
        PLT["Platform<br/><i>detect OS + arch</i>"]
        BR["BinaryResolver<br/><i>download + cache</i>"]
        JG["JwtGenerator<br/><i>sign JWT tokens + opaque keys</i>"]
        PA["PortAllocator<br/><i>allocate ports</i>"]
        AP["ApiProxy<br/><i>reverse proxy + key translation</i>"]
        SB["StackBuilder<br/><i>wire ServiceDefs</i>"]
        LS["LocalStack<br/><i>lifecycle facade</i>"]
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
    BR --> SB
    JG --> CS
    PA --> CS
    SB --> BG
    BG --> ORC
    ORC --> LS
    LS --> CS
    AP --> CS
    BUN --> CS
    NODE --> CS
    CS --> SI
```

The package has no CLI and no config-file parser. It is a library: callers supply a `StackConfig` object and get back a `Stack` with a rich interface including `dispose()`. The Vitest integration, a future CLI command, or any other host can use `createStack()` from either `bun.ts` or `node.ts` as its entry point.

---

## Relationship to process-compose

`@supabase/local` and `@supabase/process-compose` have a clean boundary: local owns _what_ to run and _where_ to get it; process-compose owns _how_ to run it.

```mermaid
graph LR
    subgraph "@supabase/local"
        direction TB
        PLAT["Platform detection"]
        BRES["Binary download + checksum"]
        SDEFS["ServiceDef construction<br/><i>postgres / postgrest / auth</i>"]
        JWTGEN["JwtGenerator<br/><i>HS256 JWT signing + opaque keys</i>"]
        PALLOC["PortAllocator<br/><i>dynamic port assignment</i>"]
        PROXY["ApiProxy<br/><i>reverse proxy + key translation</i>"]
        BUILD["StackBuilder"]
        LSTACK["LocalStack"]
        CSTACK["createStack()<br/><i>resolveConfig + layer wiring</i>"]
    end

    subgraph "@supabase/process-compose"
        direction TB
        BGRAPH["buildGraph()<br/><i>validates + sorts deps</i>"]
        ORCH["Orchestrator<br/><i>spawn, health, log, restart, shutdown</i>"]
        LB["LogBuffer"]
    end

    SDEFS --> BGRAPH
    BUILD --> BGRAPH
    BGRAPH --> ORCH
    JWTGEN --> CSTACK
    PALLOC --> CSTACK
    PROXY --> LSTACK
    LSTACK --> ORCH
```

| Concern                          | Owner                       |
| -------------------------------- | --------------------------- |
| OS / arch detection              | `@supabase/local`           |
| Binary download, cache, verify   | `@supabase/local`           |
| ServiceDef construction          | `@supabase/local`           |
| JWT generation                   | `@supabase/local`           |
| Opaque API key translation       | `@supabase/local`           |
| Reverse proxy (GoTrue/PostgREST) | `@supabase/local`           |
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

The three mapping functions return `null` for unsupported platforms — `BinaryResolver` converts `null` into a `BinaryNotFoundError`. Returning `null` rather than throwing keeps the logic pure and easy to test without an Effect context.

**Platform support matrix:**

| Service   | darwin-arm64    | linux-x64             | linux-arm64      | win32-x64        |
| --------- | --------------- | --------------------- | ---------------- | ---------------- |
| postgres  | `darwin-arm64`  | `linux-x64`           | `linux-arm64`    | `null` (Docker)  |
| postgrest | `macos-aarch64` | `linux-static-x86-64` | `ubuntu-aarch64` | `windows-x86-64` |
| auth      | `null` (Docker) | `x86`                 | `arm64`          | `null` (Docker)  |

When a mapping function returns `null`, `BinaryResolver` fails with `BinaryNotFoundError`. `StackBuilder` catches that specific error for postgres and auth and falls back to Docker-based service definitions. Auth is Linux-only as a native binary — on macOS and Windows it uses Docker. Postgres has no Windows binary — on Windows it uses Docker. PostgREST has native binaries on all supported platforms including Windows (as a `.zip` archive instead of `.tar.xz`).

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

`resolveService` is a thin helper that wraps `BinaryResolver.resolve()` and implements the binary-first, Docker-fallback strategy shared by both `StackBuilder.build()` and `prefetch()`.

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

`prefetch` downloads all service binaries and pulls all Docker images concurrently, so the first `createStack()` call in a test run does not stall on slow downloads.

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

For each requested service, `prefetch` calls `resolveService()`:

- If the result is `{ type: "binary" }`, the binary is already cached — nothing more to do.
- If the result is `{ type: "docker" }`, `prefetch` runs `docker pull <image>` via `ChildProcessSpawner`. A non-zero exit code or a `PlatformError` both map to `DockerPullError`.

All services are resolved and pulled concurrently (`concurrency: "unbounded"`). The returned `PrefetchResult` maps each service name to its `ServiceResolution`.

#### Typical usage — vitest globalSetup

```ts
// vitest.config.ts / globalSetup.ts
import { prefetch } from "@supabase/local/bun";

export async function setup() {
  await prefetch(); // downloads postgres + postgrest + auth before any test runs
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

Both share `postgresEnv()` and `postgresHealthCheck()` helpers. The Docker variant mounts the data directory as a volume (`-v dataDir:/var/lib/postgresql/data`) and uses `--network=host` so postgres is reachable on `127.0.0.1`.

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

Auth has two factories because the native binary is Linux-only:

```ts
// Native binary — Linux only
export const makeAuthServiceNative = (opts: NativeAuthOptions): ServiceDef

// Docker — fallback for macOS and Windows
export const makeAuthServiceDocker = (opts: DockerAuthOptions): ServiceDef
```

Both factories share the `authEnv()` helper which builds the `GOTRUE_*` environment variables from the same `AuthBaseOptions`. The native factory sets `command` to the binary path; the Docker factory sets `command: "docker"` and builds `args: ["run", "--rm", "--network=host", ...envArgs, image]`.

The `--network=host` flag is essential for the Docker variant: GoTrue needs to reach postgres on `127.0.0.1`, which is the host's loopback interface, not the container's. Without `--network=host`, `127.0.0.1` would resolve to the container itself and the connection would fail.

Both variants use an HTTP health check on `GET /health` (the GoTrue health endpoint). Both depend on postgres being `healthy` before starting.

---

### StackBuilder — assemble the dependency graph

**File:** `src/StackBuilder.ts`

`StackBuilder` coordinates binary resolution and service definition construction, then passes the complete `ServiceDef[]` list to `buildGraph()` from `@supabase/process-compose`.

#### Service interface

```ts
class StackBuilder extends ServiceMap.Service<
  StackBuilder,
  {
    readonly build: (config: ResolvedStackConfig) => Effect.Effect<ResolvedGraph, StackBuildError>;
  }
>()("local/StackBuilder") {}
```

`build()` is the only method. It takes a fully resolved `ResolvedStackConfig` (all defaults applied, ports concrete, JWTs generated) and returns a `ResolvedGraph` — the process-compose data structure that already knows start order, stop order, and dependency relationships.

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
    A["build(config)"] --> B["detectPlatform()"]
    B --> C{"config.mode === 'docker'?"}
    C -->|"yes"| CX["skip binary resolution<br/>use Docker images directly"]
    C -->|"no"| D["resolveService(postgres)"]
    D -->|"ChecksumMismatchError"| E["StackBuildError"]
    D -->|"ServiceResolution"| F{"config.auth !== false?"}

    F -->|"yes"| G["resolveService(auth)"]
    F -->|"no"| H{"config.postgrest !== false?"}
    G -->|"ChecksumMismatchError"| E
    G -->|"ServiceResolution"| H

    H -->|"yes"| I["resolveService(postgrest)"]
    H -->|"no"| J["buildPostgresDefs()"]
    I -->|"ChecksumMismatchError"| E
    I -->|"ServiceResolution"| J
    CX --> J

    J --> K["buildPostgrestDefs() — empty if postgrest=false"]
    K --> L["buildAuthDefs() — empty if auth=false"]
    L --> M["buildGraph(allDefs)"]
    M -->|"error"| E
    M -->|"ok"| N["ResolvedGraph"]
```

All three services call `resolveService()` for binary-first Docker fallback. The service is included when its config is an object; setting `config.postgrest = false` or `config.auth = false` skips resolution and produces an empty defs list for that service.

`ChecksumMismatchError` (from `resolveService`) propagates as a `StackBuildError` — a tampered download is never silently replaced by Docker.

#### Docker mode (`mode: "docker"`)

When `config.mode === "docker"`, binary resolution is skipped entirely — `resolveService()` is not called and `BinaryResolver` is never consulted. Instead, Docker images are used directly for all services:

- **Postgres** — runs as a Docker container with a custom entrypoint that injects `schema.sql` to configure role passwords and JWT settings before the database accepts connections.
- **Auth** — the migration step runs as a separate short-lived Docker container (`gotrue migrate`) rather than as a native subprocess. The main auth service also runs in Docker.
- **PostgREST** — runs as a Docker container using the standard PostgREST image.

Docker mode requires Docker to be installed and running. It is selected by passing `mode: "docker"` in the `StackConfig`; the default (`"auto"`) preserves the existing binary-first Docker-fallback behavior.

#### Per-service builder helpers

Three private helper functions contain the service definition construction logic, keeping `build()` itself readable:

- **`buildPostgresDefs(resolution, config, needsDockerAccess, platformOs)`** — builds the postgres and postgres-init `ServiceDef` objects. `postgres-init` is only added when the native binary path is available (not for Docker). In Docker mode, a custom entrypoint injects `schema.sql` to configure role passwords and JWT settings.
- **`buildPostgrestDefs(resolution, config, hasPostgresInit, dbHost, platformOs)`** — returns an empty array when `config.postgrest === false`; otherwise builds one PostgREST `ServiceDef`. Supports both binary and Docker variants.
- **`buildAuthDefs(resolution, config, hasPostgresInit, dbHost, platformOs)`** — returns an empty array when `config.auth === false`; otherwise builds the long-lived `auth` `ServiceDef`. Auth waits on `postgres-init` when native Postgres is used, or directly on Postgres health in Docker-backed flows.

`StackBuilder` sits between `BinaryResolver` (its dependency) and `LocalStack` (its consumer). This separation is deliberate: `StackBuilder.build()` can be tested in isolation by providing a mocked `BinaryResolver` layer without touching filesystem, network, or process spawning.

---

### LocalStack — lifecycle management

**File:** `src/LocalStack.ts`

`LocalStack` is the top-level Effect service that ties the stack together. It builds the graph via `StackBuilder`, constructs an `Orchestrator` layer internally, and exposes a rich lifecycle interface including per-service control, status streaming, and log streaming.

#### Service interface

```ts
class LocalStack extends ServiceMap.Service<
  LocalStack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void, ServiceReadyError>;
    readonly stop: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly stopService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly restartService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: () => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("local/LocalStack") {}
```

#### StackInfo

```ts
interface StackInfo {
  readonly url: string; // "http://127.0.0.1:<apiPort>"
  readonly dbUrl: string; // "postgresql://postgres:postgres@127.0.0.1:<dbPort>/postgres"
  readonly publishableKey: string; // opaque key for SDK consumers
  readonly secretKey: string; // opaque key for SDK consumers (privileged)
  readonly anonJwt: string; // internal HS256 JWT (role: "anon")
  readonly serviceRoleJwt: string; // internal HS256 JWT (role: "service_role")
}
```

The `url` points to the `ApiProxy` listener, not to PostgREST directly. Callers use `publishableKey` / `secretKey` as their API keys; the proxy translates them to JWTs internally.

#### Layer construction

```mermaid
graph TB
    subgraph "LocalStack.layer(config)"
        SB["StackBuilder.build(config)<br/><i>produces ResolvedGraph</i>"]
        LB["LogBuffer.layer<br/><i>shared between Orchestrator + LocalStack</i>"]
        OL["Orchestrator.layer(graph)<br/><i>provided with shared LogBuffer</i>"]
        EP["Layer.buildWithScope(orchLayer, scope)<br/><i>scoped to LocalStack's scope</i>"]
        INFO["StackInfo object<br/><i>built from ResolvedStackConfig — no JWT generation needed</i>"]
    end

    SB --> LB
    LB --> OL
    OL --> EP
    EP --> INFO
```

The `LogBuffer` is created at `LocalStack` level and shared with the `Orchestrator`. This gives `LocalStack` direct access to `logBuffer.subscribe(name)`, `logBuffer.subscribeAll()`, and `logBuffer.history(name, limit)` — powering the `subscribeLogs`, `subscribeAllLogs`, and `logHistory` methods without going through the Orchestrator.

Public status is projected in `@supabase/stack`, not exposed raw from `@supabase/process-compose`.
Helper jobs like `postgres-init` remain part of the process graph, but the public stack API hides
them and instead projects their lifecycle onto the owning service. While `postgres-init` is active,
callers see `postgres: Initializing`.

The Orchestrator layer is constructed inside `LocalStack.layer` using `Layer.buildWithScope`. This means the Orchestrator lives within `LocalStack`'s scope: when `LocalStack`'s layer is torn down (when the runtime is disposed), the Orchestrator's scope closes, which triggers `FiberMap` to interrupt all service fibers and run their shutdown finalizers.

#### JWT fields and key naming

`LocalStack` reads `anonJwt` and `serviceRoleJwt` directly from the `ResolvedStackConfig` passed to `LocalStack.layer(config)`. JWT generation happens upstream in `resolveConfig()` (in `createStack.ts`), not inside `LocalStack`. `LocalStack` simply propagates the already-generated values into `StackInfo`. These internal JWTs are used by `ApiProxy` to authenticate with GoTrue and PostgREST. Callers receive `publishableKey` and `secretKey` (opaque tokens) from `StackInfo`.

---

### createStack — platform-agnostic core

**File:** `src/createStack.ts`

`createStack` is the platform-agnostic core. It wires all layers, delegates to a `ManagedRuntime`, and returns a rich `Stack` interface. It takes a `PlatformFactory` parameter — a function `(apiPort: number) => PlatformLayer` — so the platform-specific HTTP server (Bun or Node.js) can be bound to the already-resolved port. Platform-specific layers (`BunHttpServer`, `NodeHttpServer`) are provided by the entry points (`bun.ts`, `node.ts`), not baked in.

`createStack` also owns `resolveConfig()`, the internal async function that turns a raw `StackConfig` into a `ResolvedStackConfig`: it allocates ports via `PortAllocator`, generates JWTs via `generateJwt()` from `JwtGenerator.ts`, creates an ephemeral temp directory if no `dataDir` was specified, and applies all service config defaults.

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
        SBL["StackBuilder.layer<br/><i>+ BinaryResolver</i>"]
        LSL["LocalStack.layer(resolvedConfig)<br/><i>+ StackBuilder</i>"]
        APL["ApiProxy.layer(proxyConfig)<br/><i>+ FetchHttpClient</i>"]
        FULL["Layer.mergeAll(LocalStack, ApiProxy)<br/><i>+ PlatformLayer</i>"]
    end

    PL --> FULL
    FH --> BRL
    BRL --> SBL
    SBL --> LSL
    LSL --> FULL
    FH --> APL
    APL --> FULL
```

The assembled layer is passed to `ManagedRuntime.make()`. A `ManagedRuntime` is an Effect runtime that holds an open scope — resources allocated inside the scope (like the Orchestrator's `FiberMap`) stay alive as long as the runtime is alive. Calling `runtime.dispose()` closes the scope, which triggers all finalizers and kills all spawned processes.

Streams (`statusChanges`, `logs`, `serviceLogs`) are converted to `AsyncIterable` via `Stream.toAsyncIterableWith(stream, services)`, which requires the runtime's services map for correct resource management.

---

### bun.ts / node.ts — platform entry points

**Files:** `src/bun.ts`, `src/node.ts`

These thin wrappers are the package's public entry points. Each one constructs the platform-specific layer and delegates to `createStack` from `createStack.ts`.

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

Callers import from the appropriate entry point:

```ts
// In a Bun project:
import { createStack } from "@supabase/local/bun";

// In a Node.js project:
import { createStack } from "@supabase/local/node";
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
        LA["ManagedRuntime.make(fullLayer)<br/><i>wires BinaryResolver → StackBuilder → LocalStack + ApiProxy</i>"]
    end

    subgraph "3. Binary resolution"
        DP["detectPlatform()"]
        CH["check ~/.supabase/bin cache"]
        DL["HttpClient.get GitHub release tarball"]
        VR["verify SHA-256 (node:crypto createHash)"]
        EX["ChildProcessSpawner → tar extract to cache"]
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
    EX --> SD
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

| File                               | Type        | What it tests                                                                                                                |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/Platform.test.ts`             | Unit        | `detectPlatform`, all three asset-name mapping functions                                                                     |
| `src/BinaryResolver.test.ts`       | Unit        | Static helpers: `downloadUrl`, `checksumUrl`, `cachePath`                                                                    |
| `src/services/services.test.ts`    | Unit        | `makePostgresService`, `makePostgresServiceDocker`, `makePostgrestService`, `makeAuthServiceNative`, `makeAuthServiceDocker` |
| `src/ApiProxy.test.ts`             | Unit        | `transformAuthorization` key translation logic, CORS headers, route routing                                                  |
| `src/StackBuilder.test.ts`         | Integration | `StackBuilder.build()` with mocked `BinaryResolver`                                                                          |
| `src/LocalStack.test.ts`           | Integration | `LocalStack.getInfo()` key naming, JWT fields, with mocked resolver + spawner                                                |
| `src/createStack.test.ts`          | Unit        | Type shape assertions + missing `stackConfig` error                                                                          |
| `tests/createStack.e2e.test.ts`    | E2e         | Full stack lifecycle: health checks, auth sign up/in/out, PostgREST CRUD                                                     |
| `tests/parallelStacks.e2e.test.ts` | E2e         | 5 concurrent stacks: port uniqueness, health check validation                                                                |

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
  const resolver = mockBinaryResolver({ failServices: ["auth"] });
  const layer = Layer.provide(StackBuilder.layer, resolver.layer);

  return Effect.gen(function* () {
    const builder = yield* StackBuilder;
    const graph = yield* builder.build(baseConfig);

    const authDef = graph.startOrder.find((s) => s.name === "auth");
    expect(authDef?.command).toBe("docker");
  }).pipe(Effect.provide(layer));
});
```

**Integration test example — `LocalStack` key naming:**

```ts
it.effect("StackInfo uses publishableKey and secretKey", () => {
  const { layer } = setupLayer(defaultConfig);

  return Effect.gen(function* () {
    const stack = yield* LocalStack;
    const info = yield* stack.getInfo();

    expect(info.publishableKey).toBe(defaultPublishableKey);
    expect(info.secretKey).toBe(defaultSecretKey);
    expect(info.anonJwt).toMatch(/^ey/); // base64url JWT
    expect(info.serviceRoleJwt).toMatch(/^ey/);
  }).pipe(Effect.provide(layer));
});
```

`LocalStack` integration tests wire three mocked layers together via `setupLayer()`:

```ts
function setupLayer(config: ResolvedStackConfig = defaultConfig) {
  const resolver = mockBinaryResolver();
  const spawner = mockChildProcessSpawner(); // from @supabase/process-compose mocks

  const layer = LocalStack.layer(config).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(resolver.layer),
    Layer.provide(spawner.layer),
  );

  return { layer, resolver, spawner };
}
```

The `mockChildProcessSpawner` is reused from `@supabase/process-compose`'s test helpers — it stubs process spawning without forking real OS processes, making `LocalStack` tests fast and deterministic.
