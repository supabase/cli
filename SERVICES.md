# Supabase CLI Services Architecture

This document describes how Docker is used to manage local Supabase services.

## Overview

The Supabase CLI uses Docker to run a complete local development environment. Services are managed through the Docker Go SDK with container labeling for project isolation, allowing multiple Supabase projects to run simultaneously.

### Services Managed

| Service | Container ID | Default Port | Description |
|---------|--------------|--------------|-------------|
| PostgreSQL | `supabase_db_<project>` | 54322 | Primary database |
| Kong | `supabase_kong_<project>` | 8000/8443 | API Gateway |
| GoTrue | `supabase_auth_<project>` | 9999 | Authentication |
| PostgREST | `supabase_rest_<project>` | 3000 | REST API |
| Realtime | `supabase_realtime_<project>` | 4000 | WebSocket subscriptions |
| Storage | `supabase_storage_<project>` | 5000 | File storage |
| ImgProxy | `supabase_imgproxy_<project>` | 5001 | Image transformations |
| Edge Functions | `supabase_edge_runtime_<project>` | 8081 | Deno runtime |
| PG Meta | `supabase_pg_meta_<project>` | 8080 | Database inspector |
| Studio | `supabase_studio_<project>` | 3000 | Web UI |
| Mailpit | `supabase_inbucket_<project>` | 8025/1025 | Email testing |
| Logflare | `supabase_analytics_<project>` | 4000 | Analytics (optional) |
| Vector | `supabase_vector_<project>` | - | Log aggregation |
| Supavisor | `supabase_pooler_<project>` | 5432/6543 | Connection pooler |

## Docker Infrastructure

### Client Initialization

**File:** [internal/utils/docker.go](internal/utils/docker.go)

The CLI uses a global Docker client singleton:

```go
var Docker = NewDocker()

func NewDocker() *client.Client {
    cli, _ := command.NewDockerCli()
    cli.Initialize(&dockerFlags.ClientOptions{})
    return cli.Client().(*client.Client)
}
```

### Container Labeling

All containers are labeled for project isolation:

- `com.supabase.cli.project=<projectId>` - CLI tracking
- `com.docker.compose.project=<projectId>` - Docker Compose compatibility

This enables running multiple local Supabase projects simultaneously and filtering operations by project.

### Network Isolation

Each project uses a dedicated Docker network (default: `supabase-cli`). Services communicate within this network using DNS aliases (container names).

**Platform-specific handling:**
- **Linux:** Adds `host.docker.internal:host-gateway` for Docker-in-Docker support
- **macOS:** No extra configuration needed
- **Windows:** Special handling for host network mode

### Image Registry

- Default registry: `public.ecr.aws` (Supabase public ECR)
- Configurable via `INTERNAL_IMAGE_REGISTRY` environment variable
- Images are pulled with retry logic (2 retries, exponential backoff)

## Starting Services (`supabase start`)

**Files:**
- [cmd/start.go](cmd/start.go) - Command definition
- [internal/start/start.go](internal/start/start.go) - Startup orchestration

### Command Flags

| Flag | Description |
|------|-------------|
| `--exclude, -x` | Comma-separated list of containers to skip |
| `--ignore-health-check` | Continue even if services fail health checks |
| `--preview` | Feature preview branch testing (hidden) |

### Startup Sequence

Services are started sequentially in this order:

1. **Database (PostgreSQL)** - Always starts first
2. **Logflare** - Analytics (if enabled)
3. **Vector** - Log aggregation (if analytics enabled)
4. **Kong** - API Gateway, routes all external requests
5. **GoTrue** - Authentication service
6. **Mailpit** - Email testing server
7. **Realtime** - WebSocket subscriptions
8. **PostgREST** - Auto-generated REST API
9. **Storage** - File storage service
10. **ImgProxy** - Image transformation proxy
11. **Edge Functions** - Deno runtime for serverless functions
12. **PG Meta** - Database management API
13. **Studio** - Web-based admin UI
14. **Supavisor** - Connection pooler

### Container Creation Flow

**Function:** `DockerStart()` in [internal/utils/docker.go](internal/utils/docker.go)

1. **Pull image** - `DockerPullImageIfNotCached()` with retry logic
2. **Create network** - `DockerNetworkCreateIfNotExists()` if needed
3. **Create volumes** - Named volumes with project labels
4. **Create container** - `Docker.ContainerCreate()` with config
5. **Start container** - `Docker.ContainerStart()`

### Database Initialization

**File:** [internal/db/start/start.go](internal/db/start/start.go)

The database has special initialization:

1. Start PostgreSQL container with custom entrypoint
2. Wait for health check (`pg_isready`)
3. Initialize schema (Supabase infrastructure tables)
4. Create vault secrets
5. Seed globals (custom roles)
6. Run service migrations in parallel:
   - Realtime: `Realtime.Tenants.health_check()`
   - Storage: `node dist/scripts/migrate-call.js`
   - Auth: `gotrue migrate`
7. Apply user migrations and seeds

### Health Check System

**File:** [internal/status/status.go](internal/status/status.go)

Services define health checks in their container config:
- **Interval:** 10 seconds
- **Timeout:** 2 seconds
- **Retries:** 3
- **Start period:** 10 seconds

Health check commands by service:
- Database: `pg_isready -U postgres -h 127.0.0.1 -p 5432`
- Storage: `wget --spider http://127.0.0.1:5000/status`
- GoTrue: `wget --spider http://127.0.0.1:9999/health`
- Logflare: `curl -sSfL --head http://127.0.0.1:4000/health`

Special cases:
- **PostgREST:** HTTP HEAD to `/rest-admin/v1/ready` (no native health check)
- **Edge Functions:** HTTP HEAD to `/functions/v1/_internal/health`

The startup waits for all services using `WaitForHealthyService()` with exponential backoff.

### Failure Handling

If any service fails to start (unless `--ignore-health-check`):
1. Log container output for debugging
2. Call `DockerRemoveAll()` to clean up all started containers
3. Return error to user

## Stopping Services (`supabase stop`)

**Files:**
- [cmd/stop.go](cmd/stop.go) - Command definition
- [internal/stop/stop.go](internal/stop/stop.go) - Shutdown logic

### Command Flags

| Flag | Description |
|------|-------------|
| `--backup` | Keep data volumes (default: true) |
| `--no-backup` | Delete all data volumes |
| `--project-id` | Stop a specific project |
| `--all` | Stop all Supabase instances on the machine |

### Shutdown Sequence

**Function:** `DockerRemoveAll()` in [internal/utils/docker.go](internal/utils/docker.go)

1. **List containers** - Filter by project label
2. **Stop containers** - Parallel execution via goroutines with `WaitAll()`
3. **Prune containers** - Remove stopped containers
4. **Prune volumes** - Only if `--no-backup` flag is set
5. **Prune networks** - Always removed

### Data Persistence

**Default behavior (with backup):**
- Volumes are preserved
- Data persists between `stop` and `start`
- Message: "Local data are backed up to docker volume"

**With `--no-backup`:**
- All volumes deleted via `VolumesPrune()`
- Complete data reset

### Graceful Shutdown

- `ContainerStop()` sends SIGTERM to containers
- Containers have default timeout to clean up
- Context cancellation flows through on SIGINT (Ctrl+C)

## Database Reset (`supabase db reset`)

**File:** [internal/db/reset/reset.go](internal/db/reset/reset.go)

Resets the database to initial state:

### PostgreSQL 15+ Flow

1. Remove database container (`ContainerRemove`)
2. Remove data volume (`VolumeRemove`)
3. Recreate container (`DockerStart`)
4. Wait for healthy
5. Setup schema
6. Restart dependent services: Storage, GoTrue, Realtime, Pooler

**Note:** PostgREST is NOT restarted as it auto-reconnects on schema changes.

### PostgreSQL 14 and Earlier

1. Recreate database via SQL commands
2. Initialize schema
3. Restart container
4. Apply migrations

## Kong API Gateway

**Template:** [internal/start/templates/kong.yml](internal/start/templates/kong.yml)

Kong routes all external requests to backend services:

| Route | Upstream Service |
|-------|------------------|
| `/auth/v1/*` | GoTrue |
| `/rest/v1/*` | PostgREST |
| `/realtime/v1/*` | Realtime |
| `/storage/v1/*` | Storage |
| `/functions/v1/*` | Edge Functions |
| `/pg/*` | PG Meta |
| `/analytics/v1/*` | Logflare |

Authentication is handled by transforming the Authorization header based on API key type.

## Vector Log Aggregation

**Template:** [internal/start/templates/vector.yaml](internal/start/templates/vector.yaml)

Vector collects logs from all containers and forwards to Logflare:

- **Source:** Docker logs (via mounted socket)
- **Transforms:** Service-specific log parsing (JSON, nginx, regex)
- **Sink:** Logflare API at `http://logflare:4000/api/logs`

## Key Files Reference

| File | Purpose |
|------|---------|
| [internal/utils/docker.go](internal/utils/docker.go) | Core Docker client and operations |
| [internal/utils/docker_darwin.go](internal/utils/docker_darwin.go) | macOS-specific network setup |
| [internal/utils/docker_linux.go](internal/utils/docker_linux.go) | Linux-specific DinD support |
| [internal/utils/docker_windows.go](internal/utils/docker_windows.go) | Windows-specific handling |
| [internal/start/start.go](internal/start/start.go) | Service startup orchestration |
| [internal/stop/stop.go](internal/stop/stop.go) | Service shutdown |
| [internal/db/start/start.go](internal/db/start/start.go) | Database initialization |
| [internal/db/reset/reset.go](internal/db/reset/reset.go) | Database reset |
| [internal/status/status.go](internal/status/status.go) | Health checking and status |
| [cmd/start.go](cmd/start.go) | Start command entry point |
| [cmd/stop.go](cmd/stop.go) | Stop command entry point |
