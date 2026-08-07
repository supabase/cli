## supabase-db-diff

Diffs schema changes made to the local or remote database.

Requires the local development stack to be running when diffing against the local database. To diff against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

Runs [djrobstep/migra](https://github.com/djrobstep/migra) in a container to compare schema differences between the target database and a shadow database. The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

Normal diff mode always compares that migrations shadow with the selected live database. Declarative files under `supabase/database/` and `[db.migrations].schema_paths` do not replace the target. Use `supabase db schema declarative sync` to compare the complete declarative desired state.

By default, all schemas in the target database are diffed. Use the `--schema public,extensions` flag to restrict diffing to a subset of schemas.

Projects created by a recent `supabase init` default to the pg-delta diff engine (`[experimental.pgdelta] enabled = true` in `config.toml`). Existing projects are unaffected and keep using migra unless they opt in. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]`, or pass `--use-migra` for a single run.

The pg-delta engine runs in-process by default and is bundled into the CLI together with pg-topo at build time. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily select the legacy edge-runtime implementation. `PGDELTA_NPM_REGISTRY`, `supabase/.temp/pgdelta-version`, and legacy catalogs under `supabase/.temp/pgdelta/` affect only that opt-out; there is no automatic fallback.

With the pg-delta engine the diff SQL is formatted by default with the same settings the declarative export uses (uppercase keywords, wrapped at a max width of 180, indented and column-aligned); execution-aware transaction boundaries are preserved as per-unit header comments in the output. Configure overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw, unformatted statements.

The bundled and legacy renderers can produce different SQL bytes or file segmentation. The compatibility contract is executable SQL and convergence: after applying the result, a subsequent diff should be empty. With `PGDELTA_DEBUG=1`, bundled-engine snapshots, plans, and diagnostics are stored under `supabase/.temp/pgdelta/v2/debug/<id>/`; those files are diagnostic artifacts, not reusable catalogs.

While the diff command is able to capture most schema changes, there are cases where it is known to fail. Currently, this could happen if you schema contains:

- Changes to publication
- Changes to storage buckets
- Views with `security_invoker` attributes
