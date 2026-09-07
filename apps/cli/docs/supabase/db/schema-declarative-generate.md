## supabase-db-schema-declarative-generate

Generate declarative schema files from a database.

Exports the schema of a live database (local, linked, or custom URL) into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

The bundled pg-delta engine writes one directory per schema at the root of that directory (`supabase/schemas/public/tables/users.sql`, `supabase/schemas/public/schema.sql`), with cluster-level objects that belong to no schema under a reserved `_cluster/` directory (`supabase/schemas/_cluster/roles.sql`). A schema literally named `_cluster` or `_custom`, in any casing, has its leading underscore percent-encoded (`%5Fcluster/`) so it can never claim a directory the export owns. Hand-authored SQL that pg-delta does not model belongs in `_custom/`, which the export never writes to and never prunes.

Emitted SQL uses the same default format as `db pull` (uppercase keywords, indent 2, width 180, column-aligned). Override with `[experimental.pgdelta] format_options`, or set `format_options = "null"` for raw statements.

pg-delta is on by default. The command is closed only when `[experimental.pgdelta] enabled = false` and `--experimental` is omitted.
