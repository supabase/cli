## supabase-db-schema-declarative-sync

Generate a new migration by diffing your declarative schema files against the current migration state.

When no declarative schema exists yet, the command offers to run `generate` first. After computing the diff, you can optionally name the migration and apply it to the local database.

The declarative directory is a complete, hand-authored desired state. Missing objects are intended removals, including extensions, regardless of whether the files were generated or whether an export manifest exists. When upgrading from the legacy workflow, regenerate the directory or add declarations for extensions you intend to retain, and review destructive-change warnings before applying.

Pg-delta and pg-topo run in-process and are bundled into the CLI at build time. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily select the legacy catalog/edge-runtime implementation; `PGDELTA_NPM_REGISTRY`, `.temp/pgdelta-version`, and catalogs at the `.temp/pgdelta/` root are legacy-only.

Generated migrations are compacted and formatted by default with pg-delta's human-facing settings (lowercase keywords, a maximum width of 180, indentation, and column alignment). Configure partial formatting overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw SQL while retaining semantic compaction. Dependency-sensitive constraints such as foreign keys may remain separate when folding them would be unsafe for migration execution.

`--no-cache` bypasses legacy catalog reuse/warming; the bundled engine extracts current state and has no reusable catalog cache. It may emit multiple ordered migration files to preserve transaction boundaries. SQL bytes may differ from the legacy renderer; successful application followed by an empty sync is the contract. With `PGDELTA_DEBUG=1`, snapshots, the plan, and diagnostics are written under `.temp/pgdelta/v2/debug/<id>/`.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
