# `inspect db collation-drift` — test evidence

All runs below were performed against a local Supabase stack (PostgreSQL 17,
ICU collator version 153.121) and a remote Supabase project, using the
locally built CLI (`pnpm dev:legacy`). The command is read-only in every mode.

## 1. Drift detected (fixture)

Fixture: a named ICU collation created with a deliberately stale recorded
version, one plain and one unique index on a column using it.

```sql
CREATE COLLATION test_stale_icu (provider = icu, locale = 'en-US', version = '73.2');
CREATE TABLE collation_drift_demo (id serial PRIMARY KEY, title text COLLATE test_stale_icu);
CREATE INDEX demo_title_idx ON collation_drift_demo (title);
CREATE UNIQUE INDEX demo_title_uniq ON collation_drift_demo (title);
```

```
$ supabase inspect db collation-drift --local
Connecting to local database...

  Database               : postgres
  Affected indexes       : 2
  Keys / unique          : 1 (a wrong sort order here can admit duplicate rows)
  Drifted ICU collations : public.test_stale_icu

  ✗  These indexes were built under different sorting rules than the system
     now provides. Postgres reports no error for this: queries may quietly
     return missing rows, sort incorrectly, or let duplicates past a unique
     constraint. Rows below are candidates and running amcheck would confirm
     which ones are actually mis-ordered.

     | Name                   | Table                       | Columns | Collation             | Stored version | Current version | Key    | Size
  ---|------------------------|-----------------------------|---------|-----------------------|----------------|-----------------|--------|------------
   ✗ | public.demo_title_uniq | public.collation_drift_demo | title   | public.test_stale_icu | 73.2           | 153.121         | UNIQUE | 8192 bytes
   ⚠ | public.demo_title_idx  | public.collation_drift_demo | title   | public.test_stale_icu | 73.2           | 153.121         |        | 8192 bytes

  1. Confirm which indexes are actually mis-ordered
     amcheck raises an error for a mis-ordered index and returns silently for
     a healthy one. Check keys and unique indexes first.

       CREATE EXTENSION IF NOT EXISTS amcheck;
       SELECT bt_index_check('public.demo_title_uniq'::regclass, heapallindexed => true);  -- unique
       SELECT bt_index_check('public.demo_title_idx'::regclass, heapallindexed => true);

  2. Rebuild the affected indexes
     Rebuild anything that failed step 1 — or all of them, which is safe if
     you would rather not check individually. CONCURRENTLY keeps the
     application online during the rebuild.

       REINDEX INDEX CONCURRENTLY public.demo_title_uniq;
       REINDEX INDEX CONCURRENTLY public.demo_title_idx;

  3. Record the new collation version — only after every rebuild has finished
     Refreshing first hides the problem without fixing it: it updates a label
     and silences the warning while leaving the indexes mis-ordered.

       ALTER COLLATION public.test_stale_icu REFRESH VERSION;
```

Constraint-backing indexes sort first and carry the ✗ marker; plain indexes
carry ⚠. Every generated statement uses the object names from the user's own
database, schema-qualified.

## 2. Full lifecycle: verify → rebuild → refresh, with output

Each stage of the prescribed workflow was executed against the fixture,
re-running the command between stages.

**Step 1 — amcheck** returned silently for both indexes — correct, because
the fixture lies about the *recorded* version while the indexes were built
under the current library. This demonstrates the "rows are candidates"
caveat: detection is a catalog comparison; corruption confirmation is
amcheck's job.

**Step 2 — reindex.** Postgres itself confirms the mismatch is still live at
rebuild time (warning emitted once per collation per session):

```
postgres=> reindex index public.demo_title_uniq;
WARNING:  collation "test_stale_icu" has version mismatch
DETAIL:  The collation in the database was created using version 73.2, but the operating system provides version 153.121.
HINT:  Rebuild all objects affected by this collation and run ALTER COLLATION public.test_stale_icu REFRESH VERSION, or build PostgreSQL with the right library version.
REINDEX
postgres=> reindex index public.demo_title_idx;
REINDEX
```

Note the HINT: Postgres prescribes exactly the statement this command
generates, schema qualification included. Re-running the command after
reindex **still reported drift** — correct: Postgres only clears the version
mismatch on REFRESH, never as a side effect of REINDEX. This is precisely why
the workflow's ordering warning exists. (Plain `REINDEX` was used here
against the idle fixture; the command emits `REINDEX INDEX CONCURRENTLY` for
production use, where the table serves live traffic.)

**Step 3 — refresh, and the report goes green:**

```
postgres=> ALTER COLLATION public.test_stale_icu REFRESH VERSION;
NOTICE:  changing version from 73.2 to 153.121
ALTER COLLATION
```

```
$ supabase inspect db collation-drift --local
Connecting to local database...

  ✓  No collation version drift detected. Indexes match the current system
     sorting rules. Re-run this check after a PostgreSQL upgrade or instance
     migration.
```

The healthy output above was captured immediately after the reindex and the
collation version refresh — detect → verify → rebuild → refresh → clean,
end to end, using the SQL the command emitted.

## 3. Healthy database (no drift)

A remote Supabase project with no drift reports the healthy state directly:

```
$ supabase inspect db collation-drift --db-url "$STAGING_DB_URL"
Connecting to remote database...

  ✓  No collation version drift detected. Indexes match the current system
     sorting rules. Re-run this check after a PostgreSQL upgrade or instance
     migration.
```

## 4. JSON mode

```
$ supabase inspect db collation-drift --local --output json
```

Emits `{ rows, report }`: `rows` is the raw driver payload (the same shape
the existing inspect commands emit), `report` is the structured document the
text renderer consumes. Verified in both the healthy and drift states.

## 5. Suite results

`tsc --noEmit` clean; unit suite green (323 files / 5903 tests, including
this command's report-builder and statement-generator tests); `fmt:check`,
`lint:check`, and the remaining `check:all` tasks pass.

## Known limitations

Expression indexes (`CREATE INDEX ON t (lower(name))`) are not detected: the
collation lives in the index expression tree rather than `pg_attribute`, so
`indkey` holds `0` and the row is skipped. Database-level (libc) drift
detection requires PostgreSQL 15+ (`pg_database.datcollversion`); named ICU
drift requires 13+. Rows are candidates until amcheck confirms them. Unlike
the sibling `inspect db` commands, internal Supabase schemas are deliberately
included — a mis-ordered index on `auth.users` is exactly as damaging as one
in `public`.
