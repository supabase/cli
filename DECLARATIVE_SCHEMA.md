# Declarative Schemas in Supabase CLI

This document explains how declarative schemas work internally in the Supabase CLI.

## Overview

Declarative schemas provide a way to define your desired database state in SQL files. Instead of writing sequential migrations, you declare what your schema should look like, and the CLI computes the necessary changes.

```
supabase/
├── schemas/           # Declarative schema files (desired state)
│   ├── tables.sql
│   ├── functions.sql
│   └── types.sql
└── migrations/        # Traditional migrations (change history)
    ├── 20240101000000_initial.sql
    └── 20240102000000_add_users.sql
```

## Key Concepts

### Schemas vs Migrations

| Aspect | Schemas (Declarative) | Migrations (Imperative) |
|--------|----------------------|------------------------|
| **Purpose** | Define desired database state | Record sequential changes over time |
| **Storage** | `supabase/schemas/` | `supabase/migrations/` |
| **Tracking** | Not tracked in migration history | Tracked in `schema_migrations` table |
| **File Format** | Any `.sql` files | Versioned: `YYYYMMDDHHMMSS_name.sql` |
| **Use Case** | Development workflow | Production deployments |

### The Shadow Database Pattern

When diffing, the CLI creates a temporary "shadow database" that represents the desired state:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Shadow Database Flow                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Create shadow DB container (fresh Postgres)                  │
│  2. Apply all migrations from supabase/migrations/               │
│  3. Apply declarative schemas from supabase/schemas/             │
│  4. Shadow DB now represents "desired state"                     │
│  5. Diff shadow DB vs local DB → generate migration SQL          │
└─────────────────────────────────────────────────────────────────┘
```

## Internal Implementation

### Directory Configuration

Defined in `pkg/config/utils.go`:

```go
var SchemasDir = filepath.Join(SupabaseDirPath, "schemas")
// Result: "supabase/schemas"
```

Can be customized in `config.toml`:

```toml
[db.migrations]
schema_paths = ["schemas/**/*.sql", "legacy_schemas/core.sql"]
```

### Loading Schema Files

From `internal/db/diff/diff.go`:

```go
func loadDeclaredSchemas(fsys afero.Fs) ([]string, error) {
    // 1. Check if schema_paths is configured in config.toml
    if schemas := utils.Config.Db.Migrations.SchemaPaths; len(schemas) > 0 {
        return schemas.Files(afero.NewIOFS(fsys))
    }

    // 2. Fall back to supabase/schemas/ directory
    if exists, err := afero.DirExists(fsys, utils.SchemasDir); !exists {
        return nil, nil  // No schemas, that's OK
    }

    // 3. Walk and collect all .sql files
    var declared []string
    afero.Walk(fsys, utils.SchemasDir, func(path string, info fs.FileInfo, err error) error {
        if info.Mode().IsRegular() && filepath.Ext(info.Name()) == ".sql" {
            declared = append(declared, path)
        }
        return nil
    })
    return declared, nil
}
```

### Applying Schemas (Without Version Tracking)

From `pkg/migration/seed.go`:

```go
func SeedGlobals(ctx context.Context, pending []string, conn *pgx.Conn, fsys fs.FS) error {
    for _, path := range pending {
        globals, err := NewMigrationFromFile(path, fsys)
        if err != nil {
            return err
        }

        // KEY: Skip inserting to migration history
        globals.Version = ""

        // Execute the SQL statements
        if err := globals.ExecBatch(ctx, conn); err != nil {
            return err
        }
    }
    return nil
}
```

The critical line is `globals.Version = ""` which prevents the schema from being recorded in the `schema_migrations` table.

### The Diff Process

From `internal/db/diff/diff.go`:

```go
func DiffDatabase(ctx context.Context, config pgconn.Config, fsys afero.Fs, ...) (string, error) {
    // 1. Create shadow database
    shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
    defer utils.DockerRemove(shadow)

    // 2. Apply migrations to shadow
    MigrateShadowDatabase(ctx, shadow, fsys)

    // 3. Apply declarative schemas to shadow's contrib_regression DB
    if declared, err := loadDeclaredSchemas(fsys); len(declared) > 0 {
        shadowConfig.Database = "contrib_regression"
        migrateBaseDatabase(ctx, shadowConfig, declared, fsys)
    }

    // 4. Compute diff: local DB → shadow DB
    // Uses migra or pg-delta depending on configuration
    diff := computeDiff(localDB, shadowDB)

    return diff, nil
}
```

### Why `contrib_regression` Database?

The shadow database has two databases:
- `postgres` - Where migrations are applied
- `contrib_regression` - Where declarative schemas are applied

This separation allows the diff tool to compare the full desired state (migrations + schemas) against the local database.

## Workflow: From Schema to Migration

### Development Flow

```
1. Edit supabase/schemas/tables.sql
   ↓
2. Run: supabase db diff -f add_profiles_table
   ↓
3. CLI creates shadow DB with schemas applied
   ↓
4. CLI diffs shadow vs local → generates SQL
   ↓
5. Migration saved: supabase/migrations/20240115120000_add_profiles_table.sql
   ↓
6. Migration can be pushed to production
```

### Dev Mode Flow (Hot Reload)

```
1. Run: supabase dev
   ↓
2. Watcher monitors supabase/schemas/
   ↓
3. File change detected → debounce 500ms
   ↓
4. Validate SQL syntax (pg_query_go)
   ↓
5. Create shadow DB, apply schemas
   ↓
6. Diff shadow vs local
   ↓
7. Apply diff directly (NO migration file created)
   ↓
8. Local DB updated, session marked "dirty"
   ↓
9. On exit: "Run 'supabase db diff -f name' to create migration"
```

## File Processing

### SQL Parsing

Schema files are parsed using `NewMigrationFromFile` which:

1. Reads the file content
2. Splits into individual SQL statements (handles `$$` blocks, comments)
3. Creates a `Migration` struct with `Statements` slice
4. Each statement is executed in order via `ExecBatch`

### Supported SQL

Any valid PostgreSQL SQL is supported:

```sql
-- supabase/schemas/tables.sql
CREATE TABLE public.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id),
    display_name text,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_profiles_user_id ON public.profiles(user_id);

-- supabase/schemas/functions.sql
CREATE OR REPLACE FUNCTION public.get_profile(user_uuid uuid)
RETURNS public.profiles AS $$
    SELECT * FROM public.profiles WHERE user_id = user_uuid;
$$ LANGUAGE sql STABLE;

-- supabase/schemas/policies.sql
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = user_id);
```

## Configuration Options

### config.toml

```toml
[db]
# Shadow database port for diffing
shadow_port = 54320

[db.migrations]
# Enable/disable migrations feature
enabled = true

# Custom schema file paths (glob patterns)
# If not set, defaults to supabase/schemas/**/*.sql
schema_paths = [
    "schemas/**/*.sql",
    "shared_schemas/*.sql"
]
```

### Glob Pattern Support

The `schema_paths` option supports:
- `**` - Recursive directory matching
- `*` - Single directory/file matching
- Multiple patterns (deduplicated)
- Results are sorted alphabetically

## Key Files in Codebase

| File | Purpose |
|------|---------|
| `pkg/config/utils.go` | Defines `SchemasDir` constant |
| `pkg/config/db.go` | `migrations.SchemaPaths` config |
| `internal/db/diff/diff.go` | `loadDeclaredSchemas`, `DiffDatabase` |
| `pkg/migration/seed.go` | `SeedGlobals` - applies schemas without tracking |
| `pkg/migration/file.go` | `NewMigrationFromFile`, `ExecBatch` |
| `internal/dev/dev.go` | Dev mode schema watching |
| `internal/dev/differ.go` | Hot reload diff/apply logic |

## Design Philosophy

1. **Schemas are for development** - Quick iteration without migration overhead
2. **Migrations are for deployment** - Immutable, versioned, auditable
3. **No automatic migration generation** - User explicitly runs `db diff` when ready
4. **Shadow database isolation** - Diffing doesn't affect local or remote databases
5. **Same SQL parser** - Schemas use the same parser as migrations for consistency
