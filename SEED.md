# Seed Behavior in `supabase dev`

**Status: FIXED** - See `internal/dev/seed.go` for implementation.

## How Seeding Works in Dev Mode

When you run `supabase dev`, seeds are executed:
1. **On startup** - After initial schema sync
2. **On seed file change** - When any file matching `[db.seed].sql_paths` is modified

## How Database State is Handled Before Reseeding

**Important:** The dev command does NOT automatically truncate or erase database state before reseeding. The seed file itself is responsible for managing existing data.

### Recommended Patterns

#### Pattern 1: TRUNCATE at the start (recommended for dev)

```sql
-- seed.sql
TRUNCATE public.users, public.posts RESTART IDENTITY CASCADE;

INSERT INTO public.users (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob');

INSERT INTO public.posts (user_id, title) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Hello World'),
  ('22222222-2222-2222-2222-222222222222', 'My First Post');
```

This is the simplest approach for development - it clears all data and re-inserts fresh.

#### Pattern 2: Upsert (INSERT ... ON CONFLICT)

```sql
-- seed.sql
INSERT INTO public.users (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob')
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  name = EXCLUDED.name;
```

This approach updates existing rows and inserts new ones, preserving any additional data.

#### Pattern 3: Delete then Insert

```sql
-- seed.sql
DELETE FROM public.posts WHERE user_id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222'
);
DELETE FROM public.users WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222'
);

INSERT INTO public.users (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob');
```

This approach is more surgical - only removes specific seed data before re-inserting.

### Why We Don't Auto-Truncate

1. **User data preservation** - You might have manually added data you want to keep
2. **Flexibility** - Different projects need different strategies
3. **Explicit is better** - The seed file clearly shows what will happen
4. **Production safety** - Same seed files can be used in different contexts

---

## Original Investigation: Why Seeds Weren't Re-Applying

### Problem

When editing `seed.sql` during `supabase dev`, the file change was detected but the seed data was not actually re-applied. The output showed:

```
[dev] Seed file change detected: supabase/seed.sql
[dev] Reseeding database...
Updating seed hash to supabase/seed.sql...
[dev] Reseed complete
```

Notice "Updating seed hash" instead of "Seeding data from" - this was the key symptom.

### Root Cause

The issue was in `pkg/migration/file.go`:

```go
func (m *SeedFile) ExecBatchWithCache(ctx context.Context, conn *pgx.Conn, fsys fs.FS) error {
    lines, err := parseFile(m.Path, fsys)
    // ...
    batch := pgx.Batch{}
    if !m.Dirty {                           // <-- KEY LINE
        for _, line := range lines {
            batch.Queue(line)               // SQL only queued if NOT dirty
        }
    }
    batch.Queue(UPSERT_SEED_FILE, m.Path, m.Hash)  // Hash always updated
    // ...
}
```

**When `Dirty` is `true` (file was modified), the SQL statements were NOT executed - only the hash was updated.**

### Why This Design Exists

This behavior is intentional for `supabase db push` and `supabase start`:

- When you pull a project that was already seeded on another machine, you don't want to re-run seeds
- You just want to mark them as "known" by updating the hash
- This prevents duplicate data or conflicts

### The Fix

For `supabase dev`, we bypass `GetPendingSeeds` entirely and always execute seed SQL:

```go
// internal/dev/seed.go

// executeSeedForDev always executes the seed SQL and updates the hash.
// This differs from SeedFile.ExecBatchWithCache which skips SQL execution for "dirty" seeds.
func executeSeedForDev(ctx context.Context, conn *pgx.Conn, seed *migration.SeedFile, fsys afero.Fs) error {
    f, err := fsys.Open(seed.Path)
    // ...
    lines, err := parser.SplitAndTrim(f)
    // ...

    // Build batch: all SQL statements + hash update
    batch := pgx.Batch{}
    for _, line := range lines {
        batch.Queue(line)  // Always execute SQL
    }
    batch.Queue(migration.UPSERT_SEED_FILE, seed.Path, seed.Hash)

    return conn.SendBatch(ctx, &batch).Close()
}
```

This keeps the existing `pkg/migration` code unchanged for `db push` and `start`, while giving dev mode the "always re-seed" behavior users expect.

## Behavior Comparison

| Command | Seed Behavior |
|---------|---------------|
| `supabase start` | Runs seeds once, skips if already applied (hash matches) |
| `supabase db push` | Runs seeds once, skips if already applied (hash matches) |
| `supabase dev` | Always re-runs seeds on file change |
