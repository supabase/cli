# Plan: Remove Docker Compose - Use Process-Compose as Sole Orchestrator

## Overview

Replace Docker Compose entirely with process-compose (embedded as a Go library) as the **sole process orchestrator** for `supabase start`. Docker is demoted to an **implementation detail** - used only to run individual services where native binaries aren't yet available.

### Key Principles

1. **Process-compose is the orchestrator** - manages all service lifecycle, dependencies, health checks
2. **Docker is an implementation detail** - just another way to run a process (like a binary)
3. **Uniform interface** - whether a service runs as a binary or Docker container, process-compose manages it the same way
4. **Path to zero Docker** - as native binaries become available, Docker usage shrinks

### Service Implementation Matrix

| Service | Current | Target | Binary Available? |
|---------|---------|--------|-------------------|
| PostgreSQL | Docker | Docker* | No (use container) |
| nginx | Docker (Kong) | Native binary | Yes |
| GoTrue (Auth) | Docker | Native binary | Yes |
| PostgREST | Docker | Native binary | Yes |
| Realtime | Docker | Docker* | No |
| Storage | Docker | Docker* | No |
| Studio | Docker | Docker* | No |
| Edge Functions | Docker | Native binary (Deno) | Yes |
| PG Meta | Docker | Docker* | No |

*Docker containers managed by process-compose via `docker run` commands

---

## Architecture Comparison

### Before (Docker Compose as Orchestrator)

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │postgres │ │  kong   │ │ gotrue  │ │postgrest│  ...      │
│  │container│ │container│ │container│ │container│           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### After (Process-Compose as Orchestrator)

```
┌─────────────────────────────────────────────────────────────┐
│                  supabase CLI (Go binary)                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │            process-compose (embedded library)            ││
│  │                                                          ││
│  │  ┌─────────────────────┐  ┌─────────────────────────┐   ││
│  │  │  Docker containers  │  │    Native binaries      │   ││
│  │  │  (docker run)       │  │                         │   ││
│  │  │  ┌────────┐         │  │  ┌───────┐ ┌─────────┐  │   ││
│  │  │  │postgres│         │  │  │ nginx │ │ gotrue  │  │   ││
│  │  │  └────────┘         │  │  └───────┘ └─────────┘  │   ││
│  │  │  ┌────────┐         │  │  ┌─────────┐            │   ││
│  │  │  │realtime│         │  │  │postgrest│            │   ││
│  │  │  └────────┘         │  │  └─────────┘            │   ││
│  │  └─────────────────────┘  └─────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Process-compose doesn't care if a process is a native binary or a `docker run` command. Both are just commands with lifecycle management.

---

## Uniform Process Model

### The Abstraction

Every service, regardless of implementation, is a `types.ProcessConfig`:

```go
// Native binary process
gotrueProcess := types.ProcessConfig{
    Command:     "/path/to/gotrue",
    Environment: gotrueEnv,
    ReadinessProbe: &types.Probe{
        HttpGet: &types.HttpProbe{Path: "/health", Port: 9999},
    },
}

// Docker container process (same interface!)
postgresProcess := types.ProcessConfig{
    Command:     "docker run --rm --name pg -p 5432:5432 supabase/postgres:17",
    ReadinessProbe: &types.Probe{
        Exec: &types.ExecProbe{Command: "docker exec pg pg_isready"},
    },
    ShutDownParams: types.ShutDownParams{
        ShutDownCommand: "docker stop pg",
    },
}
```

### Benefits

1. **Unified dependency management** - `gotrue` depends on `postgres` regardless of how postgres runs
2. **Unified health checks** - HTTP probes for binaries, exec probes for containers
3. **Unified logging** - process-compose captures stdout/stderr from both
4. **Unified shutdown** - SIGTERM for binaries, `docker stop` for containers
5. **Easy migration** - swap `docker run` for binary path when available

---

## Implementation Plan

### Phase 1: Process-Compose Library Integration

#### 1.1 Add process-compose as Go dependency

```bash
go get github.com/F1bonacc1/process-compose@v1.43.1
```

#### 1.2 Create process abstraction layer

**File:** `internal/sandbox/process.go`

```go
package sandbox

import (
    "github.com/F1bonacc1/process-compose/src/types"
)

// ProcessBuilder creates process-compose process configurations
type ProcessBuilder interface {
    Build(cfg *Config, ctx *SandboxContext) types.ProcessConfig
}

// BinaryProcess runs a native binary
type BinaryProcess struct {
    Name        string
    BinaryPath  string
    Args        []string
    Environment map[string]string
    DependsOn   []string
    HealthCheck HealthCheck
}

func (p *BinaryProcess) Build(cfg *Config, ctx *SandboxContext) types.ProcessConfig {
    return types.ProcessConfig{
        Command:     p.BinaryPath,
        Args:        p.Args,
        Environment: p.Environment,
        DependsOn:   buildDependencies(p.DependsOn),
        ReadinessProbe: p.HealthCheck.ToProbe(),
    }
}

// DockerProcess runs a Docker container (implementation detail)
type DockerProcess struct {
    Name          string
    Image         string
    ContainerName string
    Ports         map[int]int  // host:container
    Environment   map[string]string
    Volumes       []string
    DependsOn     []string
    HealthCheck   HealthCheck
}

func (p *DockerProcess) Build(cfg *Config, ctx *SandboxContext) types.ProcessConfig {
    // Build docker run command
    args := []string{"run", "--rm", "--name", p.ContainerName}

    for host, container := range p.Ports {
        args = append(args, "-p", fmt.Sprintf("%d:%d", host, container))
    }
    for k, v := range p.Environment {
        args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
    }
    for _, vol := range p.Volumes {
        args = append(args, "-v", vol)
    }
    args = append(args, p.Image)

    return types.ProcessConfig{
        Command:  "docker",
        Args:     args,
        DependsOn: buildDependencies(p.DependsOn),
        ReadinessProbe: p.HealthCheck.ToProbe(),
        ShutDownParams: types.ShutDownParams{
            ShutDownCommand: fmt.Sprintf("docker stop %s", p.ContainerName),
            ShutDownTimeout: 10,
        },
    }
}
```

### Phase 2: Service Definitions

#### 2.1 PostgreSQL (Docker - no binary available)

**File:** `internal/sandbox/services/postgres.go`

```go
func NewPostgresProcess(cfg *config.Config, ctx *SandboxContext) *DockerProcess {
    return &DockerProcess{
        Name:          "postgres",
        Image:         cfg.Db.Image,
        ContainerName: ctx.ContainerName("db"),
        Ports: map[int]int{
            ctx.Ports.Postgres: 5432,
        },
        Environment: map[string]string{
            "POSTGRES_PASSWORD": cfg.Db.Password,
            "JWT_SECRET":        cfg.Auth.JwtSecret.Value,
            "JWT_EXP":           fmt.Sprintf("%d", cfg.Auth.JwtExpiry),
        },
        Volumes: []string{
            ctx.VolumeName("db") + ":/var/lib/postgresql/data",
        },
        HealthCheck: HealthCheck{
            Type:    "exec",
            Command: fmt.Sprintf("docker exec %s pg_isready -U postgres", ctx.ContainerName("db")),
            Interval: 5,
            Timeout:  2,
            Retries:  3,
        },
    }
}
```

#### 2.2 nginx (Native binary)

**File:** `internal/sandbox/services/nginx.go`

```go
func NewNginxProcess(cfg *config.Config, ctx *SandboxContext) *BinaryProcess {
    return &BinaryProcess{
        Name:       "nginx",
        BinaryPath: GetNginxPath(),
        Args:       []string{"-c", ctx.NginxConfigPath(), "-e", "stderr"},
        DependsOn:  []string{"gotrue", "postgrest"},
        HealthCheck: HealthCheck{
            Type: "tcp",
            Port: ctx.Ports.Nginx,
        },
    }
}
```

#### 2.3 GoTrue (Native binary)

**File:** `internal/sandbox/services/gotrue.go`

```go
func NewGotrueProcess(cfg *config.Config, ctx *SandboxContext) *BinaryProcess {
    dbURL := fmt.Sprintf("postgresql://supabase_auth_admin:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)

    return &BinaryProcess{
        Name:       "gotrue",
        BinaryPath: GetGotruePath(),
        Environment: map[string]string{
            "GOTRUE_API_HOST":        "0.0.0.0",
            "GOTRUE_API_PORT":        fmt.Sprintf("%d", ctx.Ports.GoTrue),
            "GOTRUE_DB_DRIVER":       "postgres",
            "GOTRUE_DB_DATABASE_URL": dbURL,
            "GOTRUE_JWT_SECRET":      cfg.Auth.JwtSecret.Value,
            "GOTRUE_JWT_EXP":         fmt.Sprintf("%d", cfg.Auth.JwtExpiry),
            "GOTRUE_SITE_URL":        cfg.Auth.SiteUrl,
            "API_EXTERNAL_URL":       fmt.Sprintf("http://127.0.0.1:%d", ctx.Ports.Nginx),
            // ... other env vars
        },
        DependsOn: []string{"gotrue-migrate"},
        HealthCheck: HealthCheck{
            Type: "http",
            Path: "/health",
            Port: ctx.Ports.GoTrue,
        },
    }
}

func NewGotrueMigrateProcess(cfg *config.Config, ctx *SandboxContext) *BinaryProcess {
    dbURL := fmt.Sprintf("postgresql://supabase_auth_admin:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)

    return &BinaryProcess{
        Name:       "gotrue-migrate",
        BinaryPath: GetGotruePath(),
        Args:       []string{"migrate"},
        Environment: map[string]string{
            "GOTRUE_DB_DRIVER":       "postgres",
            "GOTRUE_DB_DATABASE_URL": dbURL,
        },
        DependsOn: []string{"postgres"},
        // One-shot process, no health check needed
    }
}
```

#### 2.4 PostgREST (Native binary)

**File:** `internal/sandbox/services/postgrest.go`

```go
func NewPostgrestProcess(cfg *config.Config, ctx *SandboxContext) *BinaryProcess {
    dbURL := fmt.Sprintf("postgresql://authenticator:%s@127.0.0.1:%d/postgres",
        cfg.Db.Password, ctx.Ports.Postgres)

    return &BinaryProcess{
        Name:       "postgrest",
        BinaryPath: GetPostgrestPath(),
        Environment: map[string]string{
            "PGRST_DB_URI":            dbURL,
            "PGRST_DB_SCHEMAS":        strings.Join(cfg.Api.Schemas, ","),
            "PGRST_DB_ANON_ROLE":      "anon",
            "PGRST_JWT_SECRET":        cfg.Auth.JwtSecret.Value,
            "PGRST_SERVER_PORT":       fmt.Sprintf("%d", ctx.Ports.PostgREST),
            "PGRST_ADMIN_SERVER_PORT": fmt.Sprintf("%d", ctx.Ports.PostgRESTAdmin),
        },
        DependsOn: []string{"postgres"},
        HealthCheck: HealthCheck{
            Type: "http",
            Path: "/",
            Port: ctx.Ports.PostgREST,
        },
    }
}
```

#### 2.5 Realtime (Docker - no binary available)

**File:** `internal/sandbox/services/realtime.go`

```go
func NewRealtimeProcess(cfg *config.Config, ctx *SandboxContext) *DockerProcess {
    return &DockerProcess{
        Name:          "realtime",
        Image:         cfg.Realtime.Image,
        ContainerName: ctx.ContainerName("realtime"),
        Ports: map[int]int{
            ctx.Ports.Realtime: 4000,
        },
        Environment: map[string]string{
            "PORT":                     "4000",
            "DB_HOST":                  "host.docker.internal",
            "DB_PORT":                  fmt.Sprintf("%d", ctx.Ports.Postgres),
            "DB_USER":                  "supabase_admin",
            "DB_PASSWORD":              cfg.Db.Password,
            "DB_NAME":                  "postgres",
            "DB_AFTER_CONNECT_QUERY":   "SET search_path TO _realtime",
            "API_JWT_SECRET":           cfg.Auth.JwtSecret.Value,
            "SECRET_KEY_BASE":          cfg.Realtime.SecretKeyBase,
            // ... other env vars
        },
        DependsOn: []string{"postgres"},
        HealthCheck: HealthCheck{
            Type: "http",
            Path: "/api/health",
            Port: ctx.Ports.Realtime,
        },
    }
}
```

#### 2.6 Storage (Docker - no binary available)

**File:** `internal/sandbox/services/storage.go`

```go
func NewStorageProcess(cfg *config.Config, ctx *SandboxContext) *DockerProcess {
    return &DockerProcess{
        Name:          "storage",
        Image:         cfg.Storage.Image,
        ContainerName: ctx.ContainerName("storage"),
        Ports: map[int]int{
            ctx.Ports.Storage: 5000,
        },
        Environment: map[string]string{
            "ANON_KEY":              cfg.Auth.AnonKey.Value,
            "SERVICE_KEY":           cfg.Auth.ServiceRoleKey.Value,
            "DATABASE_URL":          fmt.Sprintf("postgresql://supabase_storage_admin:%s@host.docker.internal:%d/postgres", cfg.Db.Password, ctx.Ports.Postgres),
            "PGRST_JWT_SECRET":      cfg.Auth.JwtSecret.Value,
            "STORAGE_BACKEND":       "file",
            "FILE_STORAGE_BACKEND_PATH": "/var/lib/storage",
            // ... other env vars
        },
        Volumes: []string{
            ctx.VolumeName("storage") + ":/var/lib/storage",
        },
        DependsOn: []string{"postgres", "imgproxy"},
        HealthCheck: HealthCheck{
            Type: "http",
            Path: "/status",
            Port: ctx.Ports.Storage,
        },
    }
}
```

### Phase 3: Project Builder

**File:** `internal/sandbox/project.go`

```go
package sandbox

import (
    "github.com/F1bonacc1/process-compose/src/types"
    "github.com/supabase/cli/pkg/config"
)

// ServiceSet defines which services to include
type ServiceSet struct {
    Postgres  bool
    GoTrue    bool
    PostgREST bool
    Nginx     bool
    Realtime  bool
    Storage   bool
    Studio    bool
    // ... etc
}

// DefaultServiceSet returns the standard set of services
func DefaultServiceSet() ServiceSet {
    return ServiceSet{
        Postgres:  true,
        GoTrue:    true,
        PostgREST: true,
        Nginx:     true,
    }
}

// FullServiceSet returns all services (like docker-compose mode)
func FullServiceSet() ServiceSet {
    return ServiceSet{
        Postgres:  true,
        GoTrue:    true,
        PostgREST: true,
        Nginx:     true,
        Realtime:  true,
        Storage:   true,
        Studio:    true,
    }
}

// BuildProject creates the process-compose project configuration
func BuildProject(cfg *config.Config, ctx *SandboxContext, services ServiceSet) *types.Project {
    project := &types.Project{
        Version:     "0.5",
        LogLocation: ctx.LogDir(),
        Processes:   make(map[string]types.ProcessConfig),
    }

    // Always include postgres (foundation)
    if services.Postgres {
        pg := NewPostgresProcess(cfg, ctx)
        project.Processes["postgres"] = pg.Build(cfg, ctx)
    }

    // Auth services
    if services.GoTrue {
        migrate := NewGotrueMigrateProcess(cfg, ctx)
        project.Processes["gotrue-migrate"] = migrate.Build(cfg, ctx)

        gotrue := NewGotrueProcess(cfg, ctx)
        project.Processes["gotrue"] = gotrue.Build(cfg, ctx)
    }

    // REST API
    if services.PostgREST {
        postgrest := NewPostgrestProcess(cfg, ctx)
        project.Processes["postgrest"] = postgrest.Build(cfg, ctx)
    }

    // API Gateway
    if services.Nginx {
        nginx := NewNginxProcess(cfg, ctx)
        project.Processes["nginx"] = nginx.Build(cfg, ctx)
    }

    // Realtime (Docker container)
    if services.Realtime {
        realtime := NewRealtimeProcess(cfg, ctx)
        project.Processes["realtime"] = realtime.Build(cfg, ctx)
    }

    // Storage (Docker container)
    if services.Storage {
        storage := NewStorageProcess(cfg, ctx)
        project.Processes["storage"] = storage.Build(cfg, ctx)
    }

    return project
}
```

### Phase 4: Main Entry Point

**File:** `internal/sandbox/sandbox.go`

```go
package sandbox

import (
    "context"
    "fmt"

    "github.com/F1bonacc1/process-compose/src/app"
    "github.com/F1bonacc1/process-compose/src/types"
    "github.com/spf13/afero"
    "github.com/supabase/cli/pkg/config"
)

type Options struct {
    Services    ServiceSet
    Interactive bool  // Show TUI
    Background  bool  // Run in background
}

func DefaultOptions() Options {
    return Options{
        Services:    DefaultServiceSet(),
        Interactive: true,
        Background:  false,
    }
}

func Run(ctx context.Context, fsys afero.Fs, opts Options) error {
    // 1. Load config
    cfg, err := config.Load(fsys)
    if err != nil {
        return fmt.Errorf("failed to load config: %w", err)
    }

    // 2. Create sandbox context
    sandboxCtx, err := NewSandboxContext(cfg.ProjectId)
    if err != nil {
        return err
    }

    // 3. Setup directories
    if err := sandboxCtx.EnsureDirectories(fsys); err != nil {
        return err
    }

    // 4. Allocate ports
    sandboxCtx.Ports, err = AllocatePorts(ctx, opts.Services)
    if err != nil {
        return fmt.Errorf("failed to allocate ports: %w", err)
    }

    // 5. Save state for stop command
    if err := sandboxCtx.SaveState(fsys); err != nil {
        return err
    }

    // 6. Install required binaries
    if err := InstallRequiredBinaries(ctx, fsys, opts.Services); err != nil {
        return fmt.Errorf("failed to install binaries: %w", err)
    }

    // 7. Generate config files (nginx.conf, etc.)
    if err := GenerateConfigFiles(cfg, sandboxCtx, fsys); err != nil {
        return err
    }

    // 8. Build project
    project := BuildProject(cfg, sandboxCtx, opts.Services)

    // 9. Print status
    PrintStartupInfo(sandboxCtx, opts.Services)

    // 10. Run
    return RunProject(ctx, project, opts)
}

func RunProject(ctx context.Context, project *types.Project, opts Options) error {
    runnerOpts := []app.ProjectOption{
        app.WithProject(project),
    }

    if opts.Interactive && !opts.Background {
        runnerOpts = append(runnerOpts, app.WithIsTuiOn(true))
    } else {
        runnerOpts = append(runnerOpts, app.WithIsTuiOn(false))
    }

    runner, err := app.NewProjectRunner(runnerOpts...)
    if err != nil {
        return fmt.Errorf("failed to create runner: %w", err)
    }

    return runner.Run()
}

func PrintStartupInfo(ctx *SandboxContext, services ServiceSet) {
    fmt.Println("Starting Supabase services...")
    fmt.Println()
    fmt.Printf("  API URL:      http://127.0.0.1:%d\n", ctx.Ports.Nginx)
    fmt.Printf("  Database:     postgresql://postgres:postgres@127.0.0.1:%d/postgres\n", ctx.Ports.Postgres)
    if services.GoTrue {
        fmt.Printf("  Auth:         http://127.0.0.1:%d\n", ctx.Ports.GoTrue)
    }
    if services.PostgREST {
        fmt.Printf("  REST:         http://127.0.0.1:%d\n", ctx.Ports.PostgREST)
    }
    if services.Realtime {
        fmt.Printf("  Realtime:     http://127.0.0.1:%d\n", ctx.Ports.Realtime)
    }
    if services.Storage {
        fmt.Printf("  Storage:      http://127.0.0.1:%d\n", ctx.Ports.Storage)
    }
    fmt.Println()
}
```

### Phase 5: Dynamic Port Allocation (Extended)

**File:** `internal/sandbox/ports.go`

```go
package sandbox

type AllocatedPorts struct {
    // Core services
    Postgres       int `json:"postgres"`
    Nginx          int `json:"nginx"`

    // Native binaries
    GoTrue         int `json:"gotrue"`
    PostgREST      int `json:"postgrest"`
    PostgRESTAdmin int `json:"postgrest_admin"`

    // Docker containers (when enabled)
    Realtime       int `json:"realtime,omitempty"`
    Storage        int `json:"storage,omitempty"`
    StorageAdmin   int `json:"storage_admin,omitempty"`
    Studio         int `json:"studio,omitempty"`
    Imgproxy       int `json:"imgproxy,omitempty"`
    PgMeta         int `json:"pgmeta,omitempty"`
    Inbucket       int `json:"inbucket,omitempty"`
    InbucketSMTP   int `json:"inbucket_smtp,omitempty"`
}

const (
    DefaultNginxPort          = 54321
    DefaultPostgresPort       = 54322
    DefaultGoTruePort         = 9999
    DefaultPostgRESTPort      = 3000
    DefaultPostgRESTAdminPort = 3001
    DefaultRealtimePort       = 4000
    DefaultStoragePort        = 5000
    DefaultStorageAdminPort   = 5001
    DefaultStudioPort         = 54323
    DefaultImgproxyPort       = 5001
    DefaultPgMetaPort         = 8080
    DefaultInbucketPort       = 54324
    DefaultInbucketSMTPPort   = 54325
)

func AllocatePorts(ctx context.Context, services ServiceSet) (*AllocatedPorts, error) {
    ports := &AllocatedPorts{}
    var err error

    // Always allocate core ports
    ports.Nginx, err = findAvailablePort(DefaultNginxPort)
    if err != nil {
        return nil, fmt.Errorf("nginx: %w", err)
    }

    ports.Postgres, err = findAvailablePort(DefaultPostgresPort)
    if err != nil {
        return nil, fmt.Errorf("postgres: %w", err)
    }

    // Allocate based on enabled services
    if services.GoTrue {
        ports.GoTrue, err = findAvailablePort(DefaultGoTruePort)
        if err != nil {
            return nil, fmt.Errorf("gotrue: %w", err)
        }
    }

    if services.PostgREST {
        ports.PostgREST, err = findAvailablePort(DefaultPostgRESTPort)
        if err != nil {
            return nil, fmt.Errorf("postgrest: %w", err)
        }
        ports.PostgRESTAdmin, err = findAvailablePort(DefaultPostgRESTAdminPort)
        if err != nil {
            return nil, fmt.Errorf("postgrest_admin: %w", err)
        }
    }

    if services.Realtime {
        ports.Realtime, err = findAvailablePort(DefaultRealtimePort)
        if err != nil {
            return nil, fmt.Errorf("realtime: %w", err)
        }
    }

    if services.Storage {
        ports.Storage, err = findAvailablePort(DefaultStoragePort)
        if err != nil {
            return nil, fmt.Errorf("storage: %w", err)
        }
    }

    // ... allocate other ports as needed

    return ports, nil
}
```

### Phase 6: Docker Container Networking

When running Docker containers alongside native binaries, networking requires special handling:

```go
// For containers to reach host services (binaries), use:
// - macOS/Windows: host.docker.internal
// - Linux: host-gateway or actual host IP

func getDockerHostAddress() string {
    switch runtime.GOOS {
    case "linux":
        // On Linux, need to use host.docker.internal with --add-host
        return "host.docker.internal"
    default:
        // macOS and Windows have built-in host.docker.internal
        return "host.docker.internal"
    }
}

// DockerProcess needs extra args for Linux
func (p *DockerProcess) Build(cfg *Config, ctx *SandboxContext) types.ProcessConfig {
    args := []string{"run", "--rm", "--name", p.ContainerName}

    // Add host.docker.internal support on Linux
    if runtime.GOOS == "linux" {
        args = append(args, "--add-host=host.docker.internal:host-gateway")
    }

    // ... rest of the build
}
```

---

## Migration Path

### Stage 1: Sandbox Mode (Current Goal)
- Process-compose manages: postgres (docker), gotrue (binary), postgrest (binary), nginx (binary)
- Docker Compose: Not used
- Flag: `--sandbox`

### Stage 2: Extended Sandbox
- Add: realtime (docker), storage (docker) via process-compose
- Still no Docker Compose
- Flag: `--sandbox` with service options

### Stage 3: Default Mode
- Process-compose becomes the default orchestrator
- Docker Compose deprecated
- No flag needed

### Stage 4: Zero Docker (Future)
- As native binaries become available:
  - Embedded PostgreSQL or binary
  - Realtime binary (when available)
  - Storage binary (when available)
- Docker optional, only for edge cases

---

## Comparison: Docker Compose vs Process-Compose

| Aspect | Docker Compose | Process-Compose |
|--------|---------------|-----------------|
| Orchestrator | External binary | Embedded Go library |
| Process types | Only containers | Any process (binary or docker run) |
| Health checks | Docker-native | HTTP, TCP, Exec probes |
| Dependencies | Container links | Process dependencies |
| Networking | Docker networks | Host networking + port mapping |
| Startup time | Slow (pull images) | Fast (binaries cached) |
| Resource usage | High (many containers) | Low (native processes) |
| Debugging | `docker logs` | Unified TUI / stdout |
| Port allocation | Static or compose-managed | Dynamic, conflict-free |

---

## File Structure

```
internal/sandbox/
├── sandbox.go              # Main entry point
├── context.go              # SandboxContext, state management
├── ports.go                # Dynamic port allocation
├── process.go              # ProcessBuilder interface
├── binary.go               # Binary download/management
├── project.go              # BuildProject, ServiceSet
├── services/
│   ├── postgres.go         # DockerProcess
│   ├── nginx.go            # BinaryProcess
│   ├── gotrue.go           # BinaryProcess
│   ├── postgrest.go        # BinaryProcess
│   ├── realtime.go         # DockerProcess (optional)
│   ├── storage.go          # DockerProcess (optional)
│   └── studio.go           # DockerProcess (optional)
├── templates/
│   └── nginx.conf.tmpl     # nginx configuration
└── stop.go                 # Cleanup and shutdown
```

---

## Dependencies

### Go Dependencies (new)
```bash
go get github.com/F1bonacc1/process-compose@v1.43.1
```

### External Requirements
- **Docker Engine:** Required for services without native binaries
- **No Docker Compose:** Not needed

### Native Binaries (downloaded)
- nginx
- gotrue
- postgrest

---

## Benefits Summary

1. **Unified orchestration** - One tool manages everything
2. **Faster startup** - Native binaries start instantly
3. **Lower resource usage** - Fewer Docker containers
4. **Better debugging** - Unified logs in TUI
5. **Flexible service selection** - Run only what you need
6. **Path to zero Docker** - Gradual migration as binaries become available
7. **Simpler architecture** - No Docker Compose layer
8. **Dynamic ports** - No conflicts between instances

---

## Verification

### Test: Mixed Binary + Docker Setup
```bash
# Start with native binaries + postgres docker
supabase start --sandbox

# Verify:
# - postgres runs as docker container
# - gotrue, postgrest, nginx run as native binaries
# - All services can communicate
# - Health checks work
# - Graceful shutdown works
```

### Test: Full Docker Services
```bash
# Start with all services including realtime, storage
supabase start --sandbox --all-services

# Verify:
# - Additional docker containers are managed by process-compose
# - Container networking works (host.docker.internal)
# - All services healthy
```

### Test: Service Selection
```bash
# Start minimal set
supabase start --sandbox --services=postgres,postgrest

# Verify:
# - Only selected services start
# - No nginx, no gotrue
# - PostgREST directly accessible
```
