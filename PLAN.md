# Plan: Supabase CLI `dev` Command - Declarative Schema Workflow

## Overview

Implement a new `supabase dev` command that provides a reactive development experience. The first workflow watches `supabase/schemas/` for changes and automatically applies them to the local database **without creating migration files**.

**Core principle**: Migrations are an implementation detail for deployment. During development, users just want to evolve their schema and see changes reflected quickly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         supabase dev                            │
├─────────────────────────────────────────────────────────────────┤
│  DevSession                                                     │
│  ├── Ensures local DB is running (starts if needed)            │
│  ├── Coordinates multiple watchers                              │
│  └── Manages graceful shutdown                                  │
├─────────────────────────────────────────────────────────────────┤
│  SchemaWatcher (first workflow)                                 │
│  ├── Watches supabase/schemas/*.sql                            │
│  ├── Debounces file changes (500ms)                            │
│  └── Triggers validation → diff → apply pipeline               │
├─────────────────────────────────────────────────────────────────┤
│  SQLValidator (pre-diff gate)                                   │
│  ├── Uses pg_query_go (libpg_query bindings)                   │
│  ├── Validates ALL .sql files in schemas folder                │
│  └── Blocks diff if any file has syntax errors                 │
├─────────────────────────────────────────────────────────────────┤
│  DevDiffer                                                      │
│  ├── Uses pg-delta CLI (via Bun in Docker)                     │
│  ├── Compares schema files vs local DB                         │
│  └── Detects DROP statements                                   │
├─────────────────────────────────────────────────────────────────┤
│  Applier                                                        │
│  ├── Executes SQL directly (no migration file)                 │
│  ├── Uses transactions when possible                           │
│  └── Shows warnings for destructive changes                    │
├─────────────────────────────────────────────────────────────────┤
│  DevState                                                       │
│  ├── Tracks "dirty" state (local differs from migrations)      │
│  └── Warns on exit if uncommitted changes exist                │
└─────────────────────────────────────────────────────────────────┘
```

### Pipeline Flow

```
File save → Debounce (500ms) → Validate ALL *.sql → Diff → Apply
                                     │
                                     ↓ (if invalid)
                               Show error:
                               "Syntax error in users.sql:15:23
                                unexpected token 'TABL'"
                               Wait for next save...
```

## Key Design Decisions

### 1. When to Diff (Handling Mid-Edit Saves)

- **500ms debounce** - Batch rapid saves (reuse existing pattern from `internal/functions/serve/watcher.go`)
- **SQL validation gate** - After debounce, validate ALL .sql files in schemas folder using Postgres parser before diffing
- **Non-blocking errors** - Parse/diff errors don't crash the watcher; just log and wait for fix

### 1.1 SQL Validation Step (Pre-Diff Gate)

After debounce fires, before running the diff:

```
File change detected → Debounce (500ms) → Validate ALL schemas/*.sql → Diff & Apply
                                                    ↓
                                          If any file invalid:
                                          - Show error with filename + line
                                          - Skip diff entirely
                                          - Wait for next file change
```

**Why validate all files, not just the changed one?**
- The diff applies ALL schema files to a shadow DB
- If any file is invalid, the diff will fail anyway
- Validating all files gives immediate feedback about the actual problem

**Implementation options for Postgres parser:**
1. **pg_query_go** (recommended) - Go bindings to libpg_query (Postgres's actual parser)
   - No DB connection needed
   - Exact same parser Postgres uses
   - Returns detailed error position
2. **Local DB validation** - Connect to local Postgres and use `PREPARE` or parse via function
   - Requires DB to be running
   - Adds network round-trip latency

### 2. Migration-less Local Development

- Changes are applied directly to local DB using `ExecBatch` (reuse from `pkg/migration/file.go`)
- **No version recorded** in `schema_migrations` table
- User runs `supabase db diff -f migration_name` when ready to commit/deploy
- On exit, warn if local DB is "dirty" (has unapplied changes)

### 3. Differ Strategy

Use **pg-delta** (`@supabase/pg-delta` npm package) because:
- Supabase's own differ, optimized for Supabase schemas
- Handles Supabase-specific patterns (auth, storage, realtime)
- CLI interface for easy invocation

**Implementation:** Run pg-delta CLI via Bun in Docker:

```bash
docker run --rm \
  --network host \
  -v supabase_bun_cache:/bun-cache \
  -e BUN_INSTALL_CACHE_DIR=/bun-cache \
  oven/bun:canary-alpine \
  x @supabase/pg-delta@1.0.0-alpha.2 plan \
  --source "postgres://postgres:postgres@localhost:54321/postgres" \
  --target "postgres://postgres:postgres@localhost:54322/contrib_regression" \
  --integration supabase \
  --format sql \
  --role postgres
```

**CLI flags:**
- `--source` - Local database URL (current state)
- `--target` - Shadow database URL (desired state with declared schemas applied)
- `--integration supabase` - Use Supabase-specific schema filtering
- `--format sql` - Output raw SQL statements
- `--role postgres` - Execute as postgres role

**Why Bun?**
- Much faster startup than edge-runtime (~100ms vs ~2s)
- `bun x` is like `npx` but faster
- Alpine image is lightweight (~50MB)
- `supabase_bun_cache` volume caches pg-delta package (only downloads once)

### 4. Handling Destructive Changes

- Detect DROP statements via regex pattern matching
- Show warnings with affected objects
- Apply anyway (in dev mode, speed > safety)
- Consider `--confirm-drops` flag for stricter mode

## File Structure

```
cmd/
└── dev.go                      # Cobra command definition

internal/dev/
├── session.go                  # DevSession orchestrator
├── feedback.go                 # Console output formatting
├── watcher/
│   ├── watcher.go              # Watcher interface
│   └── schema.go               # Schema watcher (adapts existing debounce pattern)
├── validator/
│   └── sql.go                  # SQL syntax validator using pg_query_go
├── differ/
│   └── schema.go               # DevDiffer using pg-schema-diff
└── state/
    └── state.go                # DevState tracking
```

## Implementation Plan

### Phase 1: Command Scaffolding
1. Create `cmd/dev.go` with Cobra command
2. Create `internal/dev/session.go` with basic lifecycle
3. Integrate with `internal/start/start.go` to ensure DB is running

### Phase 2: Schema Watcher
1. Create `internal/dev/watcher/schema.go`
2. Adapt `debounceFileWatcher` from `internal/functions/serve/watcher.go`
3. Watch `supabase/schemas/*.sql` with 500ms debounce

### Phase 3: SQL Validator (Pre-Diff Gate)
1. Add `github.com/pganalyze/pg_query_go/v6` dependency
2. Create `internal/dev/validator/sql.go`
3. Implement `ValidateSchemaFiles(paths []string) error` that:
   - Parses each file with pg_query_go
   - Returns first error with filename, line, column, and message
   - Returns nil if all files are valid

### Phase 4: Diff and Apply (using pg-delta via Bun)
1. Create `internal/dev/differ.go`
2. Implement `runPgDelta()` that:
   - Creates `supabase_bun_cache` Docker volume (if not exists)
   - Runs `oven/bun:canary-alpine` container with:
     - `--network host` to access local databases
     - `-v supabase_bun_cache:/bun-cache` for caching
     - `-e BUN_INSTALL_CACHE_DIR=/bun-cache`
     - Command: `x @supabase/pg-delta@1.0.0-alpha.2 plan --source <local-url> --target <shadow-url> --integration supabase --format sql --role postgres`
3. Parse output SQL and apply directly without version tracking

### Phase 5: Feedback and State
1. Create `internal/dev/feedback.go` for colored console output
2. Create `internal/dev/state/state.go` for dirty state tracking
3. Show warnings for DROP statements
4. Warn on exit if dirty

### Phase 6: Polish
1. Add `--no-start` flag (assume DB already running)
2. Handle edge cases (DB stops unexpectedly, etc.)
3. Document the workflow

## Critical Files to Modify/Reference

| File | Purpose |
|------|---------|
| `cmd/dev.go` | New file - command definition |
| `internal/dev/dev.go` | Main session orchestration |
| `internal/dev/watcher.go` | File watcher with debounce |
| `internal/dev/validator.go` | SQL syntax validator (pg_query_go v6) |
| `internal/dev/differ.go` | Diff and apply logic (pg-delta via Bun) |
| `internal/functions/serve/watcher.go` | Reference for file watcher pattern |
| `internal/utils/docker.go` | Reference for Docker volume/container patterns |
| `pkg/migration/file.go` | Reference for `ExecBatch` pattern |
| `internal/start/start.go` | Integration point for DB startup |
| `go.mod` | Add `github.com/pganalyze/pg_query_go/v6` dependency |

## Example User Experience

```
$ supabase dev

[14:32:15] Starting local database...
[14:32:18] Local database ready
[14:32:18] Watching supabase/schemas/ for changes...
[14:32:18] Press Ctrl+C to stop

[14:32:45] Change detected: supabase/schemas/users.sql
[14:32:46] Applied:
    CREATE TABLE public.profiles (
        id uuid PRIMARY KEY REFERENCES auth.users(id),
        display_name text
    );

[14:33:12] Change detected: supabase/schemas/users.sql
[14:33:12] Warning: DROP statement detected
    DROP COLUMN display_name;
[14:33:13] Applied:
    ALTER TABLE public.profiles DROP COLUMN display_name;
    ALTER TABLE public.profiles ADD COLUMN full_name text;

[14:33:45] Change detected: supabase/schemas/users.sql
[14:33:45] Syntax error in supabase/schemas/users.sql
    Line 3, Column 8: syntax error at or near "TABL"
    Waiting for valid SQL...

^C
[14:35:00] Stopping...
[14:35:00] Warning: Local database has uncommitted schema changes!
    Hint: Run 'supabase db diff -f migration_name' to create a migration
```

## Verification

1. **Manual testing**:
   - Run `supabase dev`
   - Edit a schema file and save
   - Verify change is applied to local DB
   - Verify no migration file is created
   - Run `supabase db diff` to see the accumulated changes
   - Run `supabase db diff -f my_migration` to create migration when ready

2. **Edge cases to test**:
   - Save mid-edit (incomplete SQL) → validation error, no diff attempted
   - Syntax error in one file while another is valid → validation catches it
   - Rapid saves (debounce working)
   - DROP statements (warning shown)
   - Ctrl+C with dirty state (warning shown)
   - DB not running at start (should start it)

## Design Decisions (Confirmed)

1. **Debounce duration**: **500ms** - Match existing pattern for fast feedback
2. **DROP statement handling**: **Apply immediately with warning** - Speed over safety in dev mode
3. **Initial state**: **Apply immediately on startup** - Sync local DB to match schema files

## Future Optimization: Lazy Container Startup

### Problem

Currently, `supabase start` pulls and starts **all** containers sequentially, even when only the database is needed:

```
postgres, kong, gotrue, postgrest, storage-api, realtime, edge-runtime,
imgproxy, postgres-meta, studio, logflare, vector, mailpit...
```

This takes 30-60+ seconds on first run (image pulls) and 10-20 seconds on subsequent runs. For `supabase dev`, we only need Postgres immediately - other services are accessed on-demand.

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    supabase start (current)                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Pull ALL images sequentially                                 │
│  2. Start ALL containers sequentially                            │
│  3. Wait for ALL health checks                                   │
│  4. Ready (~30-60s first run, ~10-20s subsequent)               │
└─────────────────────────────────────────────────────────────────┘
```

Kong gateway already routes all API requests:
- `/auth/v1/*` → gotrue:9999
- `/rest/v1/*` → postgrest:3000
- `/storage/v1/*` → storage:5000
- `/realtime/v1/*` → realtime:4000
- `/functions/v1/*` → edge-runtime:8081
- etc.

### Proposed Architecture: Lazy Proxy

```
┌─────────────────────────────────────────────────────────────────┐
│                    supabase dev (optimized)                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Start Postgres only (~3-5s)                                  │
│  2. Start LazyProxy (replaces Kong initially)                    │
│  3. Ready for schema development immediately                     │
├─────────────────────────────────────────────────────────────────┤
│  LazyProxy (on first request to service)                         │
│  ├── Intercept request to /auth/v1/*                            │
│  ├── Pull gotrue image (if needed)                              │
│  ├── Start gotrue container                                      │
│  ├── Wait for health check                                       │
│  ├── Forward request (and all subsequent requests)              │
│  └── Show "Starting auth service..." in CLI                     │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Strategy

#### Option A: Custom Go Proxy (Recommended)

Build a lightweight reverse proxy in Go that:
1. Listens on Kong's port (8000)
2. Maps routes to container configs
3. On first request to a route:
   - Returns "503 Service Starting" or holds the request
   - Pulls image + starts container in background
   - Once healthy, forwards request
4. Subsequent requests go directly to container

```go
// internal/dev/proxy/lazy.go
type LazyProxy struct {
    services map[string]*ServiceState  // route prefix → state
    mu       sync.RWMutex
}

type ServiceState struct {
    Config      ContainerConfig
    Started     bool
    Starting    bool
    ContainerID string
}

func (p *LazyProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    service := p.routeToService(r.URL.Path)
    if service == nil {
        http.Error(w, "Not found", 404)
        return
    }

    if !service.Started {
        p.startService(service)  // blocks until healthy
    }

    service.Proxy.ServeHTTP(w, r)
}
```

#### Option B: Kong with Lazy Backend Plugin

Use Kong but with a custom plugin that:
1. Catches connection failures to backends
2. Triggers container start via Docker API
3. Retries after container is healthy

This is more complex (requires Lua/Kong plugin development) but keeps the existing Kong setup.

### Service Dependency Graph

Some services have dependencies:
```
postgres (required first)
    ↓
postgrest (needs postgres)
gotrue (needs postgres)
storage-api (needs postgres, gotrue for auth)
realtime (needs postgres)
    ↓
kong (needs all above for routing)
studio (needs kong, postgres-meta)
```

For lazy startup:
- **Immediate**: postgres
- **On-demand**: everything else, respecting dependencies

### Configuration

```toml
# config.toml
[dev]
lazy_services = true  # default: true for `supabase dev`

[dev.eager_services]
# Services to start immediately (not lazily)
# Useful if you know you'll need auth immediately
auth = false
rest = false
```

### CLI Integration

```
$ supabase dev

Starting Postgres... done (3.2s)
Lazy proxy ready on localhost:54321

Watching supabase/schemas/ for changes...

# User's app makes request to /auth/v1/signup
Starting auth service... done (4.1s)

# User's app makes request to /rest/v1/profiles
Starting REST API... done (2.3s)
```

### Benefits

1. **Faster iteration**: Schema development starts in ~5s instead of ~30s
2. **Lower resource usage**: Unused services don't consume memory
3. **Better DX**: Clear feedback when services start on-demand
4. **Backwards compatible**: `supabase start` unchanged, `supabase dev` uses lazy mode

### Challenges

1. **First request latency**: 2-5s delay on first request to a service
2. **Dependency ordering**: Must start dependencies before dependents
3. **Health check timing**: Need to wait for service to be truly ready
4. **WebSocket services**: Realtime needs special handling for persistent connections

### Files to Create/Modify

| File | Purpose |
|------|---------|
| `internal/dev/proxy/lazy.go` | Lazy proxy implementation |
| `internal/dev/proxy/routes.go` | Route → container mapping |
| `internal/dev/proxy/health.go` | Health check logic |
| `internal/start/start.go` | Add `--lazy` flag support |
| `pkg/config/config.go` | Add `[dev]` config section |

### Migration Path

1. **Phase 1**: Implement for `supabase dev` only (current scope)
2. **Phase 2**: Add `supabase start --lazy` flag for opt-in
3. **Phase 3**: Consider making lazy default for `supabase start`

## Extensible Workflow Design

The `dev` command supports multiple workflows, each with its own configuration section. This allows users to customize behavior based on their tooling (Supabase-native, Prisma, Drizzle, etc.).

### Config Structure

```toml
[dev.schemas]
# Database schema workflow
enabled = true                # Set to false to disable this workflow
watch = ["schemas/**/*.sql"]  # Glob patterns to watch (relative to supabase/)
on_change = ""                # Custom command to run on change (overrides internal diff)
types = ""                    # Path for TypeScript types (empty = disabled)
debounce = 500                # Milliseconds to wait before triggering (default: 500)
sync_on_start = true          # Apply schema on startup (default: true)

[dev.functions]
# Edge functions workflow (future)
enabled = true
watch = ["functions/**/*.ts"]
# ... function-specific options
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `bool` | `true` | Enable/disable this workflow |
| `watch` | `string[]` | `["schemas/**/*.sql"]` | Glob patterns for files to watch (relative to `supabase/` directory) |
| `on_change` | `string` | `""` (empty = use internal differ) | Custom command to run when files change |
| `types` | `string` | `""` (empty = disabled) | Output path for TypeScript types |
| `debounce` | `int` | `500` | Milliseconds to wait after file change before triggering |
| `sync_on_start` | `bool` | `true` | Whether to apply schema changes on startup |

**Important:** All `watch` paths are relative to the `supabase/` directory, not the project root.

### How It Works

```
File change detected
       ↓
   Debounce (500ms)
       ↓
   on_change set? ─── Yes ──→ Run custom command
       │                            ↓
       No                     types set? ─── Yes ──→ Generate types
       ↓                            │
   Internal differ                  No
   (pg-delta)                       ↓
       ↓                         Done
   Apply to local DB
       ↓
   types set? ─── Yes ──→ Generate types
       │
       No
       ↓
     Done
```

### Typical Workflows

#### 1. Supabase Users (Default)

Users who write SQL directly in `supabase/schemas/`.

**Config** (default, no config needed):
```toml
# No config needed - defaults work out of the box
```

**Workflow**:
```
1. Edit supabase/schemas/tables.sql
2. Save file
3. CLI validates SQL syntax (pg_query_go)
4. CLI diffs schema files vs local DB (pg-delta)
5. CLI applies changes directly to local DB
6. (Optional) Types generated if configured
7. When ready: `supabase db diff -f migration_name`
```

**With TypeScript types**:
```toml
[dev.schemas]
types = "src/types/database.ts"
```

---

#### 2. Drizzle Users

Users who define schemas in TypeScript using Drizzle ORM.

**Config**:
```toml
[dev.schemas]
watch = ["../src/db/schema/**/*.ts"]  # Use ../ to reach project root from supabase/
on_change = "npx drizzle-kit push"
sync_on_start = false  # Drizzle manages its own state
```

**Workflow**:
```
1. Edit src/db/schema/users.ts (Drizzle schema)
2. Save file
3. CLI detects change, runs `npx drizzle-kit push`
4. Drizzle pushes changes directly to local DB
5. When ready: `npx drizzle-kit generate` for migrations
```

**Note**: Drizzle users typically use `drizzle-kit push` for dev and `drizzle-kit generate` for migrations. The CLI just watches and triggers their existing workflow.

---

#### 3. Prisma Users

Users who define schemas using Prisma ORM.

**Config**:
```toml
[dev.schemas]
watch = ["../prisma/schema.prisma"]  # Use ../ to reach project root from supabase/
on_change = "npx prisma db push --skip-generate"
sync_on_start = false  # Prisma manages its own state
```

**Workflow**:
```
1. Edit prisma/schema.prisma
2. Save file
3. CLI detects change, runs `npx prisma db push --skip-generate`
4. Prisma pushes changes directly to local DB
5. When ready: `npx prisma migrate dev` for migrations
```

**Note**: `--skip-generate` avoids regenerating the Prisma client on every save. Users can run `npx prisma generate` separately when needed.

---

#### 4. External Watch Mode (ORM handles everything)

Users who prefer their ORM's built-in watch mode and don't need Supabase CLI to watch schemas at all.

**Config**:
```toml
[dev.schemas]
enabled = false  # Disable schema workflow entirely
```

**Workflow**:
```
1. Run `supabase dev` (starts DB, but no schema watching)
2. In another terminal: run ORM's watch mode (e.g., `prisma studio`, custom watcher)
3. ORM handles schema changes and can call `supabase gen types typescript` if needed
4. When ready: use ORM's migration tooling
```

**Use cases**:
- Prisma users who prefer `prisma studio` or a custom dev script
- Teams with existing watch tooling they don't want to replace
- Users who only want `supabase dev` for edge functions workflow (future)

**Note**: Even with `enabled = false`, users still benefit from `supabase dev` for:
- Automatic database startup
- Future workflows like edge functions (`[dev.functions]`)
- Unified dev experience across Supabase services

---

### TypeScript Type Generation

Type generation is **independent** of the schema sync method. It runs after changes are applied to the database, regardless of whether the internal differ or a custom `on_change` command was used.

**Supported generators** (future):
- `supabase gen types typescript` (built-in)
- Custom command via config

**Config**:
```toml
[dev.schemas]
types = "src/types/database.ts"
# or for custom generator:
# types_command = "npx prisma generate"
```

**When types are generated**:
1. After successful schema application (internal or external)
2. Only if `types` path is configured
3. Uses `supabase gen types typescript --local > <path>`

---

### DX Improvements

#### 1. Clear Status Feedback

The CLI provides clear, structured output during the dev session:

```
[dev] Watching schemas/**/*.sql
[dev] On change: (internal differ)
[dev] Status: Applying changes...
[dev] ✓ Schema applied successfully
[dev] Status: Watching for changes...
```

#### 2. Validation on Startup

Before starting the watch loop, the CLI validates:
- Watch patterns are valid glob syntax
- `on_change` command exists (if configured) - warns if not found in PATH
- `types` output directory exists - warns if parent directory missing
- Watch directories exist - creates `supabase/schemas/` if using default pattern

#### 3. Dynamic Directory Watching

When a new subdirectory is created within a watched path, it's automatically added to the watcher. This handles cases like:
```
supabase/schemas/
├── tables.sql
└── new-module/        # Created while dev is running
    └── models.sql     # Automatically watched
```

#### 4. Configurable Debounce

The `debounce` option allows tuning the delay between file save and action trigger:
- **Lower values (100-300ms)**: Faster feedback, but may trigger on incomplete saves
- **Default (500ms)**: Good balance for most editors
- **Higher values (1000ms+)**: For slower machines or complex operations

#### 5. Skip Initial Sync

The `sync_on_start` option controls whether to apply schema on startup:
- **`true` (default)**: Ensures local DB matches schema files immediately
- **`false`**: Useful when using `on_change` with an ORM that's already in sync

---

### Why This Design?

1. **Backwards compatible** - No config needed for default Supabase workflow
2. **Tool agnostic** - Works with any ORM/tool that has a CLI
3. **Composable** - Type generation works with any schema tool
4. **Extensible** - Easy to add new workflows (`[dev.functions]`, `[dev.seed]`, etc.)

---

## Open Question: "Valid but Incomplete" Schema Problem

### The Problem

Current validation only checks SQL syntax. But a statement can be **valid yet incomplete**:

```sql
-- Step 1: User saves this (valid SQL!)
CREATE TABLE users (id uuid PRIMARY KEY);

-- Step 2: User continues typing (also valid, but different!)
CREATE TABLE users (id uuid PRIMARY KEY, name text, email text);
```

If we diff after step 1, we create a table with 1 column. Then we have to ALTER to add columns. This creates:
- Unnecessary churn (multiple diffs for one logical change)
- Potential issues with constraints, foreign keys
- Confusing diff output

### Replit's Approach (Reference)

[Replit's automated migrations](https://blog.replit.com/production-databases-automated-migrations) takes a different approach:
- **Don't diff during development** - Let developers make any changes freely
- **Diff at deploy time** - Generate migration only when deploying to production
- **Minimal intervention** - Users shouldn't think about migrations during dev

This works well for AI agents but may lose the "immediate feedback" benefit for human developers.

### Proposed Solutions

#### Option A: Explicit Sync Command
```toml
[dev.schemas]
auto_apply = false  # New option, default: true
```
- Changes are validated but NOT auto-applied
- User runs `supabase db sync` when ready
- **Pro**: User is always in control
- **Con**: Loses reactive feel

#### Option B: Preview Mode with Confirmation
```
[dev] Change detected: users.sql
[dev] Will apply:
      CREATE TABLE users (id uuid PRIMARY KEY);
[dev] Press Enter to apply, or keep editing...
```
- Show diff preview, wait for confirmation (Enter) or timeout
- **Pro**: Immediate feedback + user control
- **Con**: Requires interaction

#### Option C: Smart Incompleteness Detection
- Detect "likely incomplete" patterns:
  - Empty tables (0 columns)
  - Tables with only PK
  - Functions with empty bodies
- Warn but don't auto-apply for these cases
- **Pro**: Catches common cases automatically
- **Con**: Can't catch all cases

#### Option D: Adaptive Debounce
- Short debounce (500ms) for small edits
- Longer debounce (2-3s) when:
  - File was just created
  - Major structural changes detected
  - Rapid consecutive saves
- **Pro**: Automatic, no config needed
- **Con**: Feels inconsistent

#### Option E: Hybrid (Recommended)

Combine the best of all approaches:

1. **Default behavior**: Auto-apply with 500ms debounce (current)
2. **New config option**: `auto_apply = false` for manual control
3. **Smart warnings**: Detect potentially incomplete schemas, show warning but apply
4. **Explicit command**: `supabase db sync` for manual trigger when `auto_apply = false`

```toml
[dev.schemas]
auto_apply = true    # Default: auto-apply on save
# auto_apply = false # Alternative: preview only, use `supabase db sync` to apply
```

### Recommendation

**Start with current behavior (auto-apply)** but add:
1. `auto_apply = false` option for users who want explicit control
2. Smart warnings for "likely incomplete" schemas (empty tables, etc.)
3. `supabase db sync` command for manual application

This gives users a choice:
- **Rapid prototyping**: `auto_apply = true` (default) - accept some churn for speed
- **Careful development**: `auto_apply = false` - diff on demand only

---

## Performance Optimization: Persistent Shadow Database

### Problem

Currently, each diff cycle takes ~15s:
- Shadow DB container creation: ~11s (Docker overhead)
- Migration application: ~3s (same migrations every time)
- Schema application + diff: ~500ms

This is too slow for a reactive dev experience.

### Solution: Persistent Shadow with Template Database

Keep the shadow container running and use PostgreSQL's `CREATE DATABASE ... TEMPLATE` for fast resets.

#### Architecture

```
First run (cold start ~14s):
  1. Start persistent shadow container
  2. Apply all migrations → creates baseline state
  3. Snapshot baseline roles: SELECT rolname FROM pg_roles
  4. CREATE DATABASE shadow_template AS TEMPLATE
  5. Apply declared schemas to contrib_regression
  6. Diff

Subsequent runs (fast path ~500ms):
  1. Clean cluster-wide objects (roles not in baseline)
  2. DROP DATABASE contrib_regression
  3. CREATE DATABASE contrib_regression TEMPLATE shadow_template
  4. Apply declared schemas
  5. Diff
```

#### Why Template + Role Tracking?

PostgreSQL template databases only copy **database-scoped objects**:
- Tables, views, functions, triggers ✓
- Extensions ✓
- Schemas ✓

They do NOT copy **cluster-wide objects**:
- Roles (CREATE ROLE, ALTER ROLE) ✗
- Role memberships ✗
- Tablespaces ✗

If declared schemas contain `CREATE ROLE`, we must track and clean them explicitly.

#### Implementation

```go
// internal/dev/shadow.go

type ShadowState struct {
    ContainerID    string
    BaselineRoles  []string  // Roles after migrations, before declared schemas
    TemplateReady  bool
    MigrationsHash string    // Invalidate template if migrations change
}

// EnsureShadowReady prepares the shadow database for diffing
func (s *ShadowState) EnsureShadowReady(ctx context.Context, fsys afero.Fs) error {
    // Check if container exists and is healthy
    if !s.isContainerHealthy(ctx) {
        // Cold start: create container, apply migrations, create template
        return s.coldStart(ctx, fsys)
    }

    // Check if migrations changed (invalidates template)
    currentHash := s.hashMigrations(fsys)
    if currentHash != s.MigrationsHash {
        return s.rebuildTemplate(ctx, fsys)
    }

    // Fast path: reset from template
    return s.resetFromTemplate(ctx)
}

// resetFromTemplate quickly resets the database state
func (s *ShadowState) resetFromTemplate(ctx context.Context) error {
    conn := s.connectToShadow(ctx)
    defer conn.Close()

    // 1. Clean cluster-wide objects created by declared schemas
    currentRoles := s.queryRoles(ctx, conn)
    for _, role := range currentRoles {
        if !slices.Contains(s.BaselineRoles, role) {
            conn.Exec(ctx, fmt.Sprintf("DROP ROLE IF EXISTS %q", role))
        }
    }

    // 2. Reset database from template
    conn.Exec(ctx, "DROP DATABASE IF EXISTS contrib_regression")
    conn.Exec(ctx, "CREATE DATABASE contrib_regression TEMPLATE shadow_template")

    return nil
}

// coldStart creates container and builds initial template
func (s *ShadowState) coldStart(ctx context.Context, fsys afero.Fs) error {
    // 1. Create and start shadow container
    s.ContainerID = createShadowContainer(ctx)
    waitForHealthy(ctx, s.ContainerID)

    // 2. Apply migrations
    applyMigrations(ctx, s.ContainerID, fsys)

    // 3. Snapshot baseline roles
    s.BaselineRoles = s.queryRoles(ctx, conn)

    // 4. Create template from current state
    conn.Exec(ctx, "CREATE DATABASE shadow_template TEMPLATE contrib_regression")
    s.TemplateReady = true
    s.MigrationsHash = s.hashMigrations(fsys)

    return nil
}
```

#### Migration Hash Strategy

Invalidate the template when migrations change:

```go
func (s *ShadowState) hashMigrations(fsys afero.Fs) string {
    h := sha256.New()

    // Walk migrations directory in sorted order
    files, _ := afero.ReadDir(fsys, "supabase/migrations")
    for _, f := range files {
        content, _ := afero.ReadFile(fsys, filepath.Join("supabase/migrations", f.Name()))
        h.Write([]byte(f.Name()))
        h.Write(content)
    }

    return hex.EncodeToString(h.Sum(nil))
}
```

#### Container Lifecycle

The shadow container is managed separately from the main `supabase start` containers:

| Event | Action |
|-------|--------|
| `supabase dev` starts | Start shadow if not running |
| `supabase dev` file change | Reuse existing shadow |
| `supabase dev` exits | Keep shadow running (for next session) |
| `supabase stop` | Stop shadow container |
| Migrations change | Rebuild template (keep container) |

#### Expected Performance

| Scenario | Time |
|----------|------|
| First run (cold) | ~14s |
| Subsequent runs (warm) | ~500ms |
| After migration change | ~3s (rebuild template) |

#### Files to Create/Modify

| File | Purpose |
|------|---------|
| `internal/dev/shadow.go` | New - Shadow state management |
| `internal/dev/differ.go` | Modify - Use ShadowState instead of creating new container |
| `internal/stop/stop.go` | Modify - Stop shadow container on `supabase stop` |

---

## Future Workflows (Out of Scope for Now)

The dev command architecture supports adding more watchers later:
- **Edge functions** (`[dev.functions]`) - Watch and hot-reload edge functions
- **Seed data** (`[dev.seed]`) - Auto-apply seed files on change
- **Type generation** - Already supported via `types` option
