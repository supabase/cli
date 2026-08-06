## supabase-db-schema-declarative-generate

Generate declarative schema files from a database.

Exports the schema of a live database (local, linked, or custom URL) into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

Pg-delta and pg-topo run in-process and are bundled into the CLI at build time. The export includes `.pgdelta-export.json` policy metadata. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily select the legacy catalog/edge-runtime implementation; `PGDELTA_NPM_REGISTRY`, `.temp/pgdelta-version`, and catalogs at the `.temp/pgdelta/` root are legacy-only.

`--no-cache` bypasses legacy catalog reuse/warming. The bundled engine always extracts live state and has no reusable catalog cache. With `PGDELTA_DEBUG=1`, structured diagnostics are written under `.temp/pgdelta/v2/debug/<id>/`. SQL bytes and grouping may differ between engines; reloading the export to the same managed state is the contract.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
