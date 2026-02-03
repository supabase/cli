# Plan: Implement `--sandbox` Mode for `supabase start`

## Overview

Add a `--sandbox` flag to the `supabase start` command that runs a minimal Supabase stack using native binaries orchestrated by [process-compose](https://github.com/F1bonacc1/process-compose) **embedded as a Go library** instead of Docker Compose.

### Services in Sandbox Mode

| Service | Implementation | Source |
|---------|---------------|--------|
| PostgreSQL | Docker container (temporary) | `supabase/postgres` image |
| nginx | Native binary | [nginx-binaries](https://jirutka.github.io/nginx-binaries/) |
| GoTrue (Auth) | Native binary | [GitHub releases](https://github.com/supabase/auth/releases) |
| PostgREST | Native binary | [GitHub releases](https://github.com/PostgREST/postgrest/releases) |

### Process Orchestration

| Component | Implementation | Benefit |
|-----------|---------------|---------|
| process-compose | **Go library** (embedded) | No external binary to download/manage |

**Not supported in sandbox mode:** Realtime, Storage, ImgProxy, Edge Functions, PG Meta, Studio, Mailpit, Logflare, Vector, Supavisor

---

## Reusable Existing Code

### MUST REUSE (to minimize duplication)

| Component | Existing Location | Reuse For |
|-----------|-------------------|-----------|
| Binary download/extract | `internal/utils/deno.go` | nginx, GoTrue, PostgREST, process-compose downloads |
| Template rendering | `internal/start/start.go` | nginx.conf template (same `//go:embed` + `template.Must` pattern) |
| Docker container start | `internal/utils/docker.go` → `DockerStart()` | PostgreSQL container |
| Docker container stop | `internal/utils/docker.go` → `DockerRemoveAll()` | Cleanup |
| Health checks | `internal/status/status.go` → `IsServiceReady()` | Service readiness |
| Backoff/retry | `internal/utils/retry.go` → `NewBackoffPolicy()` | Health check polling |
| Config loading | `internal/utils/flags/config_path.go` → `LoadConfig()` | Already loaded by cmd |
| Container ID generation | `internal/utils/config.go` → `GetId()` | `supabase_db_<projectId>` |
| Port error handling | `internal/utils/docker.go` → `parsePortBindError()` | Port conflict messages |

### Key Patterns to Follow

```go
// Binary path pattern (from deno.go)
func GetDenoPath() string {
    home, _ := os.UserHomeDir()
    return filepath.Join(home, ".supabase", "deno")
}

// Container ID pattern (from config.go)
func GetId(name string) string {
    return "supabase_" + name + "_" + Config.ProjectId
}

// Template pattern (from start.go)
//go:embed templates/kong.yml
var kongConfigEmbed string
var kongConfigTemplate = template.Must(template.New("kongConfig").Parse(kongConfigEmbed))
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  supabase CLI (Go binary)                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │            process-compose (embedded library)            ││
│  │  ┌─────────────┐  ┌─────────────────────────────────┐   ││
│  │  │  postgres   │  │  nginx   gotrue   postgrest     │   ││
│  │  │  (docker)   │  │           (binaries)            │   ││
│  │  └─────────────┘  └─────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

Process-compose library orchestrates:
1. Docker containers via `docker run` commands
2. Native binaries directly

**Key advantage:** No external process-compose binary to download/manage. The orchestration logic is compiled directly into the CLI.

---

## Multi-Instance Support

Multiple sandbox instances can run in parallel on the same host. This requires:

### Dynamic Port Allocation

Instead of fixed ports, we dynamically find available ports at startup:

```go
// internal/sandbox/ports.go

import (
    "fmt"
    "net"

    "github.com/supabase/cli/internal/utils"
)

const (
    DefaultPostgresPort       = 54322
    DefaultNginxPort          = 54321
    DefaultGoTruePort         = 9999
    DefaultPostgRESTPort      = 3000
    DefaultPostgRESTAdminPort = 3001

    MaxPortSearchAttempts     = 100
)

type AllocatedPorts struct {
    Postgres       int  `json:"postgres"`
    Nginx          int  `json:"nginx"`
    GoTrue         int  `json:"gotrue"`
    PostgREST      int  `json:"postgrest"`
    PostgRESTAdmin int  `json:"postgrest_admin"`
}

func AllocatePorts(ctx context.Context) (*AllocatedPorts, error) {
    ports := &AllocatedPorts{}
    var err error

    ports.Postgres, err = findAvailablePortSequential(DefaultPostgresPort)
    if err != nil {
        return nil, fmt.Errorf("postgres port: %w", err)
    }
    ports.Nginx, err = findAvailablePortSequential(DefaultNginxPort)
    if err != nil {
        return nil, fmt.Errorf("nginx port: %w", err)
    }
    ports.GoTrue, err = findAvailablePortSequential(DefaultGoTruePort)
    if err != nil {
        return nil, fmt.Errorf("gotrue port: %w", err)
    }
    ports.PostgREST, err = findAvailablePortSequential(DefaultPostgRESTPort)
    if err != nil {
        return nil, fmt.Errorf("postgrest port: %w", err)
    }
    ports.PostgRESTAdmin, err = findAvailablePortSequential(DefaultPostgRESTAdminPort)
    if err != nil {
        return nil, fmt.Errorf("postgrest admin port: %w", err)
    }

    return ports, nil
}

func findAvailablePortSequential(defaultPort int) (int, error) {
    for offset := 0; offset < MaxPortSearchAttempts; offset++ {
        port := defaultPort + offset
        if port > 65535 {
            break
        }
        if isPortAvailable(port) {
            return port, nil
        }
    }
    return 0, fmt.Errorf("no available port found starting from %d (tried %d ports)",
        defaultPort, MaxPortSearchAttempts)
}

func isPortAvailable(port int) bool {
    listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
    if err != nil {
        return false
    }
    listener.Close()
    return true
}
```

**REUSE for error messages:** When port conflicts occur, use existing patterns:
```go
// From internal/utils/docker.go
// parsePortBindError() and suggestDockerStop() provide helpful CLI suggestions
// utils.CmdSuggestion can be set to show hints to user
```

### Namespacing Strategy

| Resource | Namespacing | Example |
|----------|-------------|---------|
| Docker containers | `supabase_<service>_<projectId>` | `supabase_db_myproject` |
| Docker volumes | `supabase_db_<projectId>` | `supabase_db_myproject` |
| Config files | `.supabase/sandbox/<projectId>/` | `.supabase/sandbox/myproject/nginx.conf` |
| Binaries | Shared globally | `~/.supabase/sandbox/bin/gotrue` |
| Port state file | `.supabase/sandbox/<projectId>/ports.json` | Stores allocated ports |

### Project-Specific Runtime Context

```go
// internal/sandbox/context.go

type SandboxContext struct {
    ProjectId   string
    Ports       *AllocatedPorts
    ConfigDir   string  // .supabase/sandbox/<projectId>/
    BinDir      string  // ~/.supabase/sandbox/bin/ (shared)
}

func NewSandboxContext(projectId string) (*SandboxContext, error) {
    homeDir, _ := os.UserHomeDir()

    return &SandboxContext{
        ProjectId: projectId,
        ConfigDir: filepath.Join(".supabase", "sandbox", projectId),
        BinDir:    filepath.Join(homeDir, ".supabase", "sandbox", "bin"),
    }, nil
}

// Container names are namespaced by project
func (c *SandboxContext) ContainerName(service string) string {
    return fmt.Sprintf("supabase_%s_%s", service, c.ProjectId)
}

// Volume names are namespaced by project
func (c *SandboxContext) VolumeName(service string) string {
    return fmt.Sprintf("supabase_%s_%s", service, c.ProjectId)
}
```

### Port State Persistence

Save allocated ports to allow `supabase stop` to find running instances:

```go
// Save ports after allocation
func (c *SandboxContext) SavePorts(ports *AllocatedPorts) error {
    data, _ := json.Marshal(ports)
    return os.WriteFile(filepath.Join(c.ConfigDir, "ports.json"), data, 0644)
}

// Load ports for stop command
func (c *SandboxContext) LoadPorts() (*AllocatedPorts, error) {
    data, err := os.ReadFile(filepath.Join(c.ConfigDir, "ports.json"))
    if err != nil {
        return nil, err
    }
    var ports AllocatedPorts
    return &ports, json.Unmarshal(data, &ports)
}
```

---

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Add `--sandbox` flag to start command

**File:** `cmd/start.go`

```go
var sandboxMode bool

func init() {
    startCmd.Flags().BoolVar(&sandboxMode, "sandbox", false, "Run in sandbox mode using process-compose")
}
```

#### 1.2 Create sandbox package structure

```
internal/
└── sandbox/
    ├── sandbox.go          # Main entry point
    ├── context.go          # SandboxContext with namespacing
    ├── ports.go            # Dynamic port allocation
    ├── binary.go           # Binary download/management
    ├── binary_darwin.go    # macOS platform detection
    ├── binary_linux.go     # Linux platform detection
    ├── binary_windows.go   # Windows platform detection
    ├── process_compose.go  # Generate process-compose.yaml + install
    ├── postgres.go         # PostgreSQL docker run config
    ├── nginx.go            # nginx binary config + nginx.conf generation
    ├── gotrue.go           # GoTrue binary config
    ├── postgrest.go        # PostgREST binary config
    └── stop.go             # Stop sandbox services
```

### Phase 2: Binary Management

#### 2.1 Binary download system

**File:** `internal/sandbox/binary.go`

**REUSE:** Copy patterns from `internal/utils/deno.go` (ZIP extraction, caching, Windows .exe handling).

```go
import (
    "archive/tar"
    "compress/gzip"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "runtime"

    "github.com/spf13/afero"
)

const (
    NginxVersion     = "1.28.1"
    GotrueVersion    = "2.186.0"
    PostgrestVersion = "14.4"
    // Note: process-compose is embedded as a Go library, no binary download needed
)

// GetSandboxBinPath returns ~/.supabase/sandbox/bin (shared across projects)
// Pattern from: internal/utils/deno.go → GetDenoPath()
func GetSandboxBinPath() string {
    home, _ := os.UserHomeDir()
    return filepath.Join(home, ".supabase", "sandbox", "bin")
}

func GetNginxPath() string {
    name := "nginx"
    if runtime.GOOS == "windows" {
        name = "nginx.exe"
    }
    return filepath.Join(GetSandboxBinPath(), name)
}

func GetGotruePath() string {
    name := "gotrue"
    if runtime.GOOS == "windows" {
        name = "gotrue.exe"
    }
    return filepath.Join(GetSandboxBinPath(), name)
}

func GetPostgrestPath() string {
    name := "postgrest"
    if runtime.GOOS == "windows" {
        name = "postgrest.exe"
    }
    return filepath.Join(GetSandboxBinPath(), name)
}

// Note: No GetProcessComposePath() needed - process-compose is embedded as a Go library

// InstallBinaryIfMissing downloads a binary if not already cached
// Pattern from: internal/utils/deno.go → InstallOrUpgradeDeno()
func InstallBinaryIfMissing(ctx context.Context, binPath, downloadURL string, fsys afero.Fs) error {
    if _, err := fsys.Stat(binPath); err == nil {
        return nil // Already installed
    }
    // Download and extract (reuse deno.go extraction logic)
    return downloadBinary(ctx, downloadURL, binPath, fsys)
}

func getNginxDownloadURL() string {
    base := "https://jirutka.github.io/nginx-binaries/"
    switch {
    case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
        return base + "nginx-" + NginxVersion + "-arm64-darwin"
    case runtime.GOOS == "darwin" && runtime.GOARCH == "amd64":
        return base + "nginx-" + NginxVersion + "-x86_64-darwin"
    case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
        return base + "nginx-" + NginxVersion + "-x86_64-linux"
    case runtime.GOOS == "linux" && runtime.GOARCH == "arm64":
        return base + "nginx-" + NginxVersion + "-aarch64-linux"
    case runtime.GOOS == "windows":
        return base + "nginx-" + NginxVersion + "-x86_64-win32.exe"
    }
    return ""
}

// Note: nginx binaries are plain executables (not archives)
// GoTrue and PostgREST are .tar.gz archives
// process-compose is .tar.gz (or .zip on Windows)
```

#### 2.2 No platform-specific files needed

Use `runtime.GOOS` and `runtime.GOARCH` directly (same as deno.go). No need for build-tagged files.

### Phase 3: Process Compose Library Integration

#### 3.1 Import process-compose as Go library

**File:** `internal/sandbox/runner.go`

```go
import (
    "github.com/F1bonacc1/process-compose/src/app"
    "github.com/F1bonacc1/process-compose/src/types"
)

// BuildProject creates an in-memory process-compose project configuration
// No YAML files needed - configuration is built programmatically
func BuildProject(cfg *config.Config, ctx *SandboxContext) *types.Project {
    return &types.Project{
        Version:     "0.5",
        LogLocation: filepath.Join(ctx.ConfigDir, "logs"),
        Processes: map[string]types.ProcessConfig{
            "postgres":       postgresProcess(cfg, ctx),
            "gotrue-migrate": gotrueMigrateProcess(cfg, ctx),
            "gotrue":         gotrueProcess(cfg, ctx),
            "postgrest":      postgrestProcess(cfg, ctx),
            "nginx":          nginxProcess(cfg, ctx),
        },
    }
}

// RunProject starts all services using the embedded process-compose library
func RunProject(ctx context.Context, project *types.Project) error {
    runner, err := app.NewProjectRunner(
        app.WithProject(project),
        app.WithIsTuiOn(true),  // Show TUI for interactive mode
    )
    if err != nil {
        return fmt.Errorf("failed to create project runner: %w", err)
    }

    // Run blocks until completion or signal
    return runner.Run()
}
```

#### 3.2 Process configuration builders

```go
// Each process is built using types.ProcessConfig directly
// No YAML serialization needed

func postgresProcess(cfg *config.Config, ctx *SandboxContext) types.ProcessConfig {
    containerName := utils.GetId("db")
    return types.ProcessConfig{
        Command:  fmt.Sprintf("docker start -a %s", containerName),
        IsDaemon: true,
        LivenessProbe: &types.Probe{
            Exec: &types.ExecProbe{
                Command: fmt.Sprintf("docker exec %s pg_isready -U postgres", containerName),
            },
            InitialDelaySeconds: 2,
            PeriodSeconds:       5,
            TimeoutSeconds:      2,
            FailureThreshold:    3,
        },
        ShutDownParams: types.ShutDownParams{
            ShutDownCommand: fmt.Sprintf("docker stop %s", containerName),
            ShutDownTimeout: 10,
        },
    }
}

func gotrueProcess(cfg *config.Config, ctx *SandboxContext) types.ProcessConfig {
    return types.ProcessConfig{
        Command:     GetGotruePath(),
        Environment: gotrueEnvVars(cfg, ctx),
        DependsOn: map[string]types.ProcessDependency{
            "gotrue-migrate": {Condition: "process_completed_successfully"},
        },
        ReadinessProbe: &types.Probe{
            HttpGet: &types.HttpProbe{
                Host:   "127.0.0.1",
                Port:   ctx.Ports.GoTrue,
                Path:   "/health",
                Scheme: "http",
            },
            InitialDelaySeconds: 2,
            PeriodSeconds:       3,
        },
        Availability: types.ProcessAvailability{
            Restart:        "on_failure",
            BackoffSeconds: 2,
            MaxRestarts:    5,
        },
    }
}

// Similar builders for postgrest and nginx processes...
```

**Key advantage:** No YAML files written to disk. Configuration is built in-memory and passed directly to the runner.

### Phase 4: Service Configurations

#### 4.1 PostgreSQL (Docker)

**File:** `internal/sandbox/postgres.go`

**REUSE:** Use existing Docker utilities from `internal/utils/docker.go` instead of raw `docker run` commands.

```go
import (
    "github.com/docker/docker/api/types/container"
    "github.com/docker/go-connections/nat"
    "github.com/supabase/cli/internal/utils"
    "github.com/supabase/cli/pkg/config"
)

// StartPostgres uses existing Docker utilities
// Pattern from: internal/db/start/start.go
func StartPostgres(ctx context.Context, cfg *config.Config, sandboxCtx *SandboxContext) error {
    image := cfg.Db.Image  // e.g., supabase/postgres:17.2.0
    containerName := utils.GetId("db")  // REUSE existing pattern: supabase_db_<projectId>

    env := []string{
        "POSTGRES_PASSWORD=" + cfg.Db.Password,
        "JWT_SECRET=" + cfg.Auth.JwtSecret.Value,
        fmt.Sprintf("JWT_EXP=%d", cfg.Auth.JwtExpiry),
    }

    hostConfig := &container.HostConfig{
        PortBindings: nat.PortMap{
            "5432/tcp": []nat.PortBinding{{
                HostPort: strconv.Itoa(sandboxCtx.Ports.Postgres),
            }},
        },
        Binds: []string{
            utils.GetId("db") + ":/var/lib/postgresql/data",
        },
    }

    containerConfig := &container.Config{
        Image: image,
        Env:   env,
        Healthcheck: &container.HealthConfig{
            Test:     []string{"CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"},
            Interval: 10 * time.Second,
            Timeout:  2 * time.Second,
            Retries:  3,
        },
    }

    // REUSE: internal/utils/docker.go → DockerStart()
    return utils.DockerStart(ctx, containerConfig, hostConfig, nil, containerName)
}

// For process-compose, we still need a command wrapper:
func PostgresProcessCommand(cfg *config.Config, sandboxCtx *SandboxContext) string {
    containerName := utils.GetId("db")
    return fmt.Sprintf("docker start -a %s", containerName)
}
```

**Alternative approach:** Since process-compose needs shell commands, use a hybrid:
1. Pre-create the container using Docker API (with health checks)
2. Use `docker start -a <container>` in process-compose to attach to it
```

**Database Initialization:**

The `supabase/postgres` image automatically runs initialization scripts that:
1. Create Supabase extensions (pgsodium, pg_graphql, pg_stat_statements, etc.)
2. Set up auth schema and roles (`supabase_auth_admin`, `authenticator`, `anon`, `authenticated`)
3. Configure JWT validation functions
4. Set up the `_supabase` internal schema

#### 4.1.1 GoTrue Migration Process

Add a separate `gotrue-migrate` process that runs before the main `gotrue` service:

```go
func GotrueMigrateProcess(cfg *config.Config, ctx *SandboxContext, binPath string) Process {
    dbURL := fmt.Sprintf("postgresql://supabase_auth_admin:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)  // Use allocated port

    return Process{
        Command: binPath + " migrate",
        Environment: map[string]string{
            "GOTRUE_DB_DRIVER":       "postgres",
            "GOTRUE_DB_DATABASE_URL": dbURL,
        },
        DependsOn: map[string]Depend{
            "postgres": {Condition: "process_healthy"},
        },
        Availability: Availability{
            Restart: "no",  // Run once only
        },
    }
}
```

Then `gotrue` depends on `gotrue-migrate`:

```yaml
gotrue:
  depends_on:
    gotrue-migrate:
      condition: process_completed_successfully
```

#### 4.2 nginx (Native Binary)

**File:** `internal/sandbox/nginx.go`

```go
func NginxProcess(ctx *SandboxContext, binPath, configPath string) Process {
    return Process{
        Command: fmt.Sprintf("%s -c %s -e stderr", binPath, configPath),
        DependsOn: map[string]Depend{
            "gotrue":   {Condition: "process_healthy"},
            "postgrest": {Condition: "process_healthy"},
        },
        ReadyLogLine: "start worker process",
        IsDaemon:     true,
        Shutdown: Shutdown{
            Signal:         15,  // SIGTERM
            TimeoutSeconds: 10,
        },
        Availability: Availability{
            Restart:     "on_failure",
            MaxRestarts: 3,
        },
    }
}
```

#### 4.3 GoTrue (Binary)

**File:** `internal/sandbox/gotrue.go`

```go
func GotrueProcess(cfg *config.Config, ctx *SandboxContext, binPath string) Process {
    dbURL := fmt.Sprintf("postgresql://supabase_auth_admin:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)  // Use allocated DB port

    env := map[string]string{
        "GOTRUE_API_HOST":              "0.0.0.0",
        "GOTRUE_API_PORT":              fmt.Sprintf("%d", ctx.Ports.GoTrue),  // Dynamic port
        "GOTRUE_DB_DRIVER":             "postgres",
        "GOTRUE_DB_DATABASE_URL":       dbURL,
        "GOTRUE_JWT_SECRET":            cfg.Auth.JwtSecret,
        "GOTRUE_JWT_EXP":               fmt.Sprintf("%d", cfg.Auth.JwtExpiry),
        "GOTRUE_JWT_AUD":               "authenticated",
        "GOTRUE_JWT_ADMIN_ROLES":       "service_role",
        "GOTRUE_SITE_URL":              cfg.Auth.SiteUrl,
        "GOTRUE_EXTERNAL_EMAIL_ENABLED": fmt.Sprintf("%v", cfg.Auth.Email.EnableSignup),
        "GOTRUE_MAILER_AUTOCONFIRM":    fmt.Sprintf("%v", !cfg.Auth.Email.EnableConfirmations),
        "API_EXTERNAL_URL":             fmt.Sprintf("http://127.0.0.1:%d", ctx.Ports.Nginx),
        // Disable SMTP for sandbox (no mailpit)
        "GOTRUE_SMTP_HOST": "",
    }

    return Process{
        Command:     binPath,
        Environment: env,
        DependsOn: map[string]Depend{
            "gotrue-migrate": {Condition: "process_completed_successfully"},
        },
        ReadyLogLine: "API started",
        Availability: Availability{
            Restart:        "on_failure",
            BackoffSeconds: 2,
            MaxRestarts:    5,
        },
    }
}
```

#### 4.4 PostgREST (Binary)

**File:** `internal/sandbox/postgrest.go`

```go
func PostgrestProcess(cfg *config.Config, ctx *SandboxContext, binPath string) Process {
    dbURL := fmt.Sprintf("postgresql://authenticator:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)  // Use allocated DB port

    env := map[string]string{
        "PGRST_DB_URI":               dbURL,
        "PGRST_DB_SCHEMAS":           strings.Join(cfg.Api.Schemas, ","),
        "PGRST_DB_EXTRA_SEARCH_PATH": strings.Join(cfg.Api.ExtraSearchPath, ","),
        "PGRST_DB_MAX_ROWS":          fmt.Sprintf("%d", cfg.Api.MaxRows),
        "PGRST_DB_ANON_ROLE":         "anon",
        "PGRST_JWT_SECRET":           cfg.Auth.JwtSecret,
        "PGRST_SERVER_PORT":          fmt.Sprintf("%d", ctx.Ports.PostgREST),       // Dynamic port
        "PGRST_ADMIN_SERVER_PORT":    fmt.Sprintf("%d", ctx.Ports.PostgRESTAdmin),  // Dynamic port
    }

    return Process{
        Command:     binPath,
        Environment: env,
        DependsOn: map[string]Depend{
            "postgres": {Condition: "process_healthy"},
        },
        ReadyLogLine: "Listening on port",
        Availability: Availability{
            Restart:        "on_failure",
            BackoffSeconds: 2,
            MaxRestarts:    5,
        },
    }
}
```

### Phase 5: nginx Configuration for Sandbox

#### 5.1 nginx config Go template

**File:** `internal/sandbox/templates/nginx.conf.tmpl`

This is a Go `text/template` file embedded via `//go:embed`. Template variables use `{{ .VarName }}` syntax and are replaced at runtime.

**Template Variables:**

| Variable | Type | Config Source | Description |
|----------|------|---------------|-------------|
| `NginxPort` | int | `sandboxCtx.Ports.Nginx` | Port nginx listens on |
| `GoTruePort` | int | `sandboxCtx.Ports.GoTrue` | GoTrue service port |
| `PostgRESTPort` | int | `sandboxCtx.Ports.PostgREST` | PostgREST service port |
| `PostgRESTAdminPort` | int | `sandboxCtx.Ports.PostgRESTAdmin` | PostgREST admin port |
| `ServiceRoleKey` | string | `cfg.Auth.SecretKey.Value` | Opaque key to match (`sb_secret_...`) |
| `ServiceRoleJWT` | string | `cfg.Auth.ServiceRoleKey.Value` | JWT Bearer token for service_role |
| `AnonKey` | string | `cfg.Auth.PublishableKey.Value` | Opaque key to match (`sb_publishable_...`) |
| `AnonJWT` | string | `cfg.Auth.AnonKey.Value` | JWT Bearer token for anon |

**Note:** JWTs are pre-generated during config loading (`pkg/config/apikeys.go`). No Docker services needed.

```nginx
# Supabase Sandbox API Gateway (Go template)
# Generated by supabase CLI - do not edit manually
#
# Template variables (replaced at runtime):
#   {{ .NginxPort }}          - nginx listen port
#   {{ .GoTruePort }}         - GoTrue service port
#   {{ .PostgRESTPort }}      - PostgREST service port
#   {{ .PostgRESTAdminPort }} - PostgREST admin port
#   {{ .ServiceRoleKey }}     - service_role API key
#   {{ .ServiceRoleJWT }}     - service_role JWT
#   {{ .AnonKey }}            - anon API key
#   {{ .AnonJWT }}            - anon JWT

worker_processes 1;
daemon off;
error_log stderr;

events {
    worker_connections 1024;
}

http {
    access_log /dev/stdout;

    #-----------------------------------------------------------------
    # Conditional Authorization Header Logic
    #-----------------------------------------------------------------
    # Replaces Kong's Lua request-transformer expression:
    #   1. If Authorization header exists and is NOT "Bearer sb_*" -> keep it
    #   2. Else if apikey == ServiceRoleKey -> "Bearer ServiceRoleJWT"
    #   3. Else if apikey == AnonKey -> "Bearer AnonJWT"
    #   4. Else -> use apikey header as-is

    # Map apikey header to corresponding JWT
    map $http_apikey $apikey_to_jwt {
        default                    $http_apikey;
        "{{ .ServiceRoleKey }}"    "Bearer {{ .ServiceRoleJWT }}";
        "{{ .AnonKey }}"           "Bearer {{ .AnonJWT }}";
    }

    # Check if Authorization is a legacy "Bearer sb_*" token (invalid)
    map $http_authorization $auth_is_legacy {
        default        0;
        "~^Bearer sb_" 1;
    }

    # Final Authorization: keep valid auth header, otherwise use mapped apikey
    # Pattern: "<auth_header>:<is_legacy>" -> if has header and not legacy, keep it
    map "$http_authorization:$auth_is_legacy" $final_authorization {
        default     $apikey_to_jwt;      # No auth or legacy -> use mapped apikey
        "~^.+:0$"   $http_authorization; # Has auth header + not legacy -> keep it
    }

    server {
        listen {{ .NginxPort }};
        server_name localhost;

        # CORS headers for all responses
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, apikey, X-Client-Info" always;
        add_header Access-Control-Expose-Headers "Content-Range, Range" always;
        add_header Access-Control-Max-Age "86400" always;

        # Handle CORS preflight
        if ($request_method = OPTIONS) {
            return 204;
        }

        #-------------------------------------------------------------
        # Auth Open Endpoints (no Authorization transformation)
        #-------------------------------------------------------------
        location /auth/v1/verify {
            proxy_pass http://127.0.0.1:{{ .GoTruePort }}/verify;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /auth/v1/callback {
            proxy_pass http://127.0.0.1:{{ .GoTruePort }}/callback;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /auth/v1/authorize {
            proxy_pass http://127.0.0.1:{{ .GoTruePort }}/authorize;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        #-------------------------------------------------------------
        # Auth Protected Endpoints (with Authorization transformation)
        # /auth/v1/* -> http://gotrue:<port>/*
        #-------------------------------------------------------------
        location /auth/v1/ {
            proxy_pass http://127.0.0.1:{{ .GoTruePort }}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Authorization $final_authorization;
        }

        #-------------------------------------------------------------
        # REST API (with Authorization transformation)
        # /rest/v1/* -> http://postgrest:<port>/*
        #-------------------------------------------------------------
        location /rest/v1/ {
            proxy_pass http://127.0.0.1:{{ .PostgRESTPort }}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Authorization $final_authorization;
        }

        #-------------------------------------------------------------
        # REST Admin API (no Authorization transformation)
        # /rest-admin/v1/* -> http://postgrest:<admin_port>/*
        #-------------------------------------------------------------
        location /rest-admin/v1/ {
            proxy_pass http://127.0.0.1:{{ .PostgRESTAdminPort }}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}
```

#### 5.2 nginx config generation

**File:** `internal/sandbox/nginx.go`

```go
import (
    "bytes"
    _ "embed"
    "path/filepath"
    "text/template"

    "github.com/spf13/afero"
    "github.com/supabase/cli/pkg/config"
)

type nginxConfig struct {
    NginxPort          int
    GoTruePort         int
    PostgRESTPort      int
    PostgRESTAdminPort int
    ServiceRoleKey     string
    ServiceRoleJWT     string
    AnonKey            string
    AnonJWT            string
}

//go:embed templates/nginx.conf.tmpl
var nginxConfigEmbed string
var nginxConfigTemplate = template.Must(template.New("nginxConfig").Parse(nginxConfigEmbed))

func GenerateNginxConfig(cfg *config.Config, ctx *SandboxContext) (string, error) {
    var buf bytes.Buffer
    err := nginxConfigTemplate.Option("missingkey=error").Execute(&buf, nginxConfig{
        NginxPort:          ctx.Ports.Nginx,
        GoTruePort:         ctx.Ports.GoTrue,
        PostgRESTPort:      ctx.Ports.PostgREST,
        PostgRESTAdminPort: ctx.Ports.PostgRESTAdmin,
        ServiceRoleKey:     cfg.Auth.SecretKey.Value,
        ServiceRoleJWT:     cfg.Auth.ServiceRoleKey.Value,
        AnonKey:            cfg.Auth.PublishableKey.Value,
        AnonJWT:            cfg.Auth.AnonKey.Value,
    })
    if err != nil {
        return "", err
    }
    return buf.String(), nil
}

// WriteNginxConfig generates and writes nginx.conf to the project sandbox directory
func WriteNginxConfig(cfg *config.Config, ctx *SandboxContext, fsys afero.Fs) (string, error) {
    configPath := filepath.Join(ctx.ConfigDir, "nginx.conf")
    content, err := GenerateNginxConfig(cfg, ctx)
    if err != nil {
        return "", err
    }
    if err := afero.WriteFile(fsys, configPath, []byte(content), 0644); err != nil {
        return "", err
    }
    return configPath, nil
}
```

### Phase 6: Main Orchestration

#### 6.1 Sandbox entry point

**File:** `internal/sandbox/sandbox.go`

```go
import (
    "github.com/F1bonacc1/process-compose/src/app"
    "github.com/F1bonacc1/process-compose/src/types"
)

func Run(ctx context.Context, fsys afero.Fs) error {
    // 1. Load config
    cfg, err := config.Load(fsys)
    if err != nil {
        return err
    }

    // 2. Create sandbox context with project namespacing
    sandboxCtx, err := NewSandboxContext(cfg.ProjectId)
    if err != nil {
        return err
    }

    // 3. Ensure config directory exists (for nginx.conf and logs)
    if err := fsys.MkdirAll(sandboxCtx.ConfigDir, 0755); err != nil {
        return err
    }

    // 4. Allocate dynamic ports
    sandboxCtx.Ports, err = AllocatePorts(ctx)
    if err != nil {
        return err
    }

    // 5. Save ports for stop command
    if err := sandboxCtx.SavePorts(sandboxCtx.Ports); err != nil {
        return err
    }

    // 6. Download service binaries if needed (shared across projects)
    // Note: No process-compose binary needed - it's embedded as a library
    if err := InstallBinaries(ctx, fsys, sandboxCtx.BinDir); err != nil {
        return err
    }

    // 7. Generate nginx.conf for this sandbox instance
    nginxConfigPath, err := WriteNginxConfig(cfg, sandboxCtx, fsys)
    if err != nil {
        return err
    }

    // 8. Pre-create PostgreSQL container (so process-compose can just start it)
    if err := CreatePostgresContainer(ctx, cfg, sandboxCtx); err != nil {
        return err
    }

    // 9. Build process-compose project in-memory (no YAML file needed)
    project := BuildProject(cfg, sandboxCtx, nginxConfigPath)

    // 10. Print allocated ports
    fmt.Printf("Sandbox starting with ports:\n")
    fmt.Printf("  API (nginx):   http://127.0.0.1:%d\n", sandboxCtx.Ports.Nginx)
    fmt.Printf("  Database:      postgresql://postgres:postgres@127.0.0.1:%d/postgres\n", sandboxCtx.Ports.Postgres)
    fmt.Printf("  Auth (GoTrue): http://127.0.0.1:%d\n", sandboxCtx.Ports.GoTrue)
    fmt.Printf("  REST API:      http://127.0.0.1:%d\n", sandboxCtx.Ports.PostgREST)

    // 11. Run using embedded process-compose library
    return RunProject(ctx, project)
}

// RunProject starts all services using the embedded process-compose library
func RunProject(ctx context.Context, project *types.Project) error {
    runner, err := app.NewProjectRunner(
        app.WithProject(project),
        app.WithIsTuiOn(true),  // Show TUI for interactive mode
    )
    if err != nil {
        return fmt.Errorf("failed to create project runner: %w", err)
    }

    // Run blocks until completion or signal (Ctrl+C)
    // process-compose handles graceful shutdown internally
    return runner.Run()
}
```

### Phase 7: Stop Command Integration

#### 7.1 Add sandbox stop support

**File:** `internal/sandbox/stop.go`

Since we use the embedded process-compose library, graceful shutdown is handled automatically when the user presses Ctrl+C. The library propagates SIGTERM to all managed processes.

```go
func Stop(ctx context.Context, fsys afero.Fs, projectId string) error {
    // Create sandbox context to get namespaced names
    sandboxCtx, err := NewSandboxContext(projectId)
    if err != nil {
        return err
    }

    // When using the library, shutdown is handled by process-compose's signal handling
    // This function is mainly for cleanup if processes were orphaned

    // Stop docker container directly using namespaced name
    dbContainer := sandboxCtx.ContainerName("db")
    if err := exec.CommandContext(ctx, "docker", "stop", dbContainer).Run(); err != nil {
        // Container might already be stopped, that's OK
    }

    // Clean up ports file
    portsFile := filepath.Join(sandboxCtx.ConfigDir, "ports.json")
    fsys.Remove(portsFile)

    return nil
}

// Check if sandbox mode is active for a project
func IsSandboxRunning(fsys afero.Fs, projectId string) bool {
    sandboxCtx, _ := NewSandboxContext(projectId)
    portsFile := filepath.Join(sandboxCtx.ConfigDir, "ports.json")
    _, err := fsys.Stat(portsFile)
    return err == nil
}
```

**Note:** When using the embedded library, the main `Run()` function blocks until Ctrl+C is pressed. The library handles SIGTERM propagation to all child processes automatically. The `Stop()` function is mainly used for cleaning up orphaned processes or when stopping from a different terminal.

---

## File Changes Summary

### New Files (Minimal Set)

| File | Purpose | Reuses From |
|------|---------|-------------|
| `internal/sandbox/sandbox.go` | Main entry point | - |
| `internal/sandbox/ports.go` | Dynamic port allocation | - |
| `internal/sandbox/binary.go` | Binary download/caching (nginx, gotrue, postgrest) | `internal/utils/deno.go` patterns |
| `internal/sandbox/nginx.go` | nginx config + process | `internal/start/start.go` template patterns |
| `internal/sandbox/templates/nginx.conf.tmpl` | nginx Go template | `internal/start/templates/kong.yml` patterns |
| `internal/sandbox/runner.go` | Process-compose library integration | - |

**Note:** No need for separate `postgres.go`, `gotrue.go`, `postgrest.go` files.
The process builders are simple functions in `runner.go`.

**Note:** No need for platform-specific `binary_darwin.go`, `binary_linux.go`, `binary_windows.go` files.
Use `runtime.GOOS` and `runtime.GOARCH` directly (same as deno.go).

**Note:** No `process_compose.go` file needed for YAML generation - configuration is built in-memory using the library's types.

### Modified Files

| File | Changes |
|------|---------|
| `cmd/start.go` | Add `--sandbox` flag, early return to `sandbox.Run()` |
| `cmd/stop.go` | Check for sandbox and call `sandbox.Stop()` |

### Files NOT Needed (Reuse Existing)

| Functionality | Reuse From |
|---------------|------------|
| Docker container management | `internal/utils/docker.go` |
| Health checks | `internal/status/status.go` |
| Backoff/retry | `internal/utils/retry.go` |
| Config loading | Already done by `cmd/start.go` |
| Container ID generation | `internal/utils/config.go` → `GetId()` |

---

## Binary Assets

### nginx
- **Version:** 1.28.1
- **Source:** https://jirutka.github.io/nginx-binaries/
- **Assets:**
  - `nginx-1.28.1-arm64-darwin` (macOS ARM64)
  - `nginx-1.28.1-x86_64-darwin` (macOS Intel)
  - `nginx-1.28.1-x86_64-linux` (Linux x86_64)
  - `nginx-1.28.1-aarch64-linux` (Linux ARM64)
  - `nginx-1.28.1-x86_64-win32.exe` (Windows)

### GoTrue (auth)
- **Version:** 2.186.0
- **Assets:**
  - `auth-v2.186.0-arm64.tar.gz` (macOS ARM64, Linux ARM64)
  - `auth-v2.186.0-x86.tar.gz` (macOS Intel, Linux x86_64)

### PostgREST
- **Version:** 14.4
- **Assets:** (typical naming pattern)
  - `postgrest-v14.4-macos-aarch64.tar.xz` (macOS ARM64)
  - `postgrest-v14.4-macos-x64.tar.xz` (macOS Intel)
  - `postgrest-v14.4-linux-static-x64.tar.xz` (Linux x86_64)
  - `postgrest-v14.4-linux-static-aarch64.tar.xz` (Linux ARM64)

### Storage Location

**Global (shared across projects):**
```
~/.supabase/sandbox/bin/
├── nginx               # or nginx.exe on Windows
├── gotrue              # or gotrue.exe on Windows
└── postgrest           # or postgrest.exe on Windows
# Note: No process-compose binary - it's embedded in the CLI
```

**Project-specific (in project directory):**
```
.supabase/sandbox/<projectId>/
├── nginx.conf            # nginx routing config with dynamic ports
├── ports.json            # Allocated ports for this instance
└── logs/                 # Process logs (managed by process-compose library)
# Note: No process-compose.yaml - configuration is built in-memory
```

**Docker resources (namespaced by project):**
```
Containers:
└── supabase_db_<projectId>

Volumes:
└── supabase_db_<projectId>
```

---

## Dependencies

### Required External Tools
- **Docker:** Still required for PostgreSQL container only (temporary until native Postgres is viable)

### Go Dependencies

**New dependency to add:**
```bash
go get github.com/F1bonacc1/process-compose@v1.43.1
```

**Existing dependencies (already in go.mod):**
- `github.com/spf13/afero` - Filesystem abstraction
- `github.com/docker/docker` - Docker API client
- `github.com/golang-jwt/jwt/v5` - JWT generation

**Note:** No process-compose binary download needed. The library is compiled directly into the CLI binary.

### Process-Compose Library Usage

The key imports from process-compose:

```go
import (
    "github.com/F1bonacc1/process-compose/src/app"      // ProjectRunner, ProjectOpts
    "github.com/F1bonacc1/process-compose/src/types"    // Project, ProcessConfig
)
```

**API Overview:**
- `types.Project` - Root configuration struct (replaces process-compose.yaml)
- `types.ProcessConfig` - Per-process configuration (command, env, dependencies, probes)
- `app.NewProjectRunner()` - Creates a runner from a Project
- `runner.Run()` - Starts all processes and blocks until completion

---

## Configuration

### config.toml Support

Sandbox mode reuses existing `config.toml` with these considerations:

1. **Ignored settings** (services not available):
   - `[realtime]`, `[storage]`, `[studio]`, `[inbucket]`, `[analytics]`, `[edge_runtime]`

2. **Respected settings**:
   - `[db]` - Port, password, major_version
   - `[api]` - Port, schemas, max_rows
   - `[auth]` - All auth configuration

3. **Modified behavior**:
   - SMTP disabled (no Mailpit)
   - Email confirmations auto-disabled

---

## Testing Strategy

1. **Unit tests** for each service config generator
2. **Integration test** that:
   - Generates process-compose.yaml
   - Validates YAML structure
   - Checks all required env vars present
3. **Manual testing** on macOS ARM64, macOS Intel, Linux x86_64

---

## Open Questions / Considerations

### 1. Integration with existing `cmd/start.go`

The current `cmd/start.go` has a large `startServices()` function. Options:
- **Option A:** Add `if sandboxMode { return sandbox.Run() }` early in the flow (minimal changes)
- **Option B:** Refactor `startServices()` to share more code (more invasive)

**Recommendation:** Option A - keep sandbox isolated to minimize risk.

### 2. Process-Compose Library vs CLI Binary

**Decision: Use as Go library (embedded)**

Advantages:
- No external binary to download/manage
- Configuration built in-memory (no YAML files to write)
- Direct error handling (no CLI output parsing)
- Graceful shutdown handled automatically by library
- Single binary deployment (everything in supabase CLI)

The core library (`src/app/`) has clean separation from CLI code (`src/cmd/`), making it suitable for embedding. Heavy dependencies (TUI, API server) are optional.

### 3. Config validation for sandbox mode

Should we validate that unsupported services are disabled in config.toml?
```go
// Warn if user has enabled services not supported in sandbox
if cfg.Storage.Enabled && sandboxMode {
    fmt.Fprintln(os.Stderr, "Warning: Storage is not available in sandbox mode")
}
```

### 4. Health checks for native binaries

Native binaries don't have Docker health checks. Options:
- **HTTP probes:** GoTrue has `/health`, PostgREST has `/` endpoint
- **Process monitoring:** process-compose has `ready_log_line` matching
- **TCP probes:** Check if port is accepting connections

**Recommendation:** Use process-compose's `ready_log_line` + HTTP probes for critical services.

### 5. Graceful shutdown

Handled automatically by the process-compose library:
- Library catches SIGTERM/SIGINT and propagates to all child processes
- Each process has configurable `ShutDownParams` (timeout, command, signal)
- Docker containers are stopped via their shutdown command (`docker stop <container>`)

**No additional signal handling code needed in the CLI.**

### 6. Logs aggregation

The process-compose library provides flexible options:
- **TUI mode:** `app.WithIsTuiOn(true)` - Interactive terminal UI with log tailing
- **Headless mode:** `app.WithIsTuiOn(false)` - Logs to stdout/stderr
- **File logging:** `project.LogLocation = ".supabase/sandbox/<projectId>/logs/"` - Write logs to files

**Recommendation:** Start with TUI mode for interactive use. Add `--background` flag later if needed.

---

## Future Enhancements

1. **Replace Docker containers with binaries:**
   - PostgreSQL: Use embedded PostgreSQL or native binary when available

2. **Add more services:**
   - Storage (when binary available)
   - Realtime (when binary available)

---

## Verification

After implementation:

### Single Instance Test
1. Run `supabase start --sandbox` in a project directory
2. Note the printed port numbers
3. Verify process-compose TUI shows all services
4. Test endpoints using printed ports:
   - `curl http://localhost:<nginx_port>/auth/v1/health` → GoTrue health
   - `curl http://localhost:<nginx_port>/rest/v1/` → PostgREST response
5. Run `supabase stop` and verify cleanup

### Multi-Instance Test (Parallel Sandboxes)
1. Open two terminals in different project directories
2. Run `supabase start --sandbox` in both
3. Verify each gets different port allocations
4. Verify both instances work independently
5. Check Docker containers are namespaced:
   ```bash
   docker ps --filter "name=supabase_db_" --format "{{.Names}}"
   # Should show: supabase_db_project1, supabase_db_project2
   ```
6. Stop both instances and verify cleanup

### Port Conflict Test
1. Manually occupy port 54321 (e.g., `nc -l 54321`)
2. Run `supabase start --sandbox`
3. Verify it uses the next sequential port (54322 for nginx if 54321 is taken)
4. Verify the allocated port is printed and works

### Sequential Port Allocation Example
If default ports are occupied:
- nginx default `54321` taken → tries `54322`, `54323`, ... until available
- Postgres default `54322` taken → tries `54323`, `54324`, ... until available
- Ports increment sequentially, staying close to defaults for predictability
