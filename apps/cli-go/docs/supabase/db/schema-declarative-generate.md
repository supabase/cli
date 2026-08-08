## supabase-db-schema-declarative-generate

Generate declarative schema files from a database.

Exports the schema of a live database (local, linked, or custom URL) into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

The generated directory becomes the complete desired state: objects omitted from it are intended removals, including extensions, with or without an export manifest. When upgrading from the legacy workflow, regenerate the directory or add declarations for every extension you intend to retain before syncing, then review destructive-change warnings before applying.

Pg-delta and pg-topo run in-process and are bundled into the CLI at build time. The export includes `.pgdelta-export.json` policy metadata. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily select the legacy catalog/edge-runtime implementation; `PGDELTA_NPM_REGISTRY`, `.temp/pgdelta-version`, and catalogs at the `.temp/pgdelta/` root are legacy-only.

Generated SQL is compacted and formatted by default with pg-delta's human-facing settings (lowercase keywords, a maximum width of 180, indentation, and column alignment). Declarative export safely folds additional constraints that remain separate in executable diff plans. Configure partial formatting overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw SQL while retaining semantic compaction.

`--no-cache` bypasses legacy catalog reuse/warming. The bundled engine always extracts live state and has no reusable catalog cache. With `PGDELTA_DEBUG=1`, structured diagnostics are written under `.temp/pgdelta/v2/debug/<id>/`. SQL bytes and grouping may differ between engines; reloading the export to the same managed state is the contract.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
