## supabase-db-schema-declarative-generate

Generate declarative schema files from a database.

Exports the schema of a live database into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

The database is the local one unless you pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command never asks which database to use. With the local database, `--reset` recreates it from your migrations first. When the destination already holds files, the command asks before overwriting them (pass `--overwrite` or `--yes` to skip the question).

The bundled pg-delta engine writes one directory per schema at the root of that directory (`supabase/schemas/public/tables/users.sql`, `supabase/schemas/public/schema.sql`), with cluster-level objects that belong to no schema under a reserved `_cluster/` directory (`supabase/schemas/_cluster/roles.sql`). When platform default grants (`anon`/`authenticated`/`service_role`) need an overlay `REVOKE ALL`, the export writes `adp_wipes.sql` after `schema.sql` in that schema — or `_cluster/adp_wipes.sql` for cluster-wide overlays — so a load onto a fresh project keeps privileges that were revoked in the source. A schema literally named `_cluster` or `_custom`, in any casing, has its leading underscore percent-encoded (`%5Fcluster/`) so it can never claim a directory the export owns. Hand-authored SQL that pg-delta does not model belongs in `_custom/`, which the export never writes to and never prunes.

Emitted SQL uses the same default format as `db pull` (uppercase keywords, indent 2, width 180, column-aligned). Override with `[experimental.pgdelta] format_options`, or set `format_options = "null"` for raw statements.

Enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass the `--experimental` flag to run it.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
