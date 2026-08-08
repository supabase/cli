## supabase-db-diff

Diffs schema changes made to the local or remote database.

Requires the local development stack to be running when diffing against the local database. To diff against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

Runs [djrobstep/migra](https://github.com/djrobstep/migra) in a container to compare schema differences between the target database and a shadow database. The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

`-f dogfood_note` names the generated migration; it does not filter the diff to the `dogfood_note` object.

| Command                          | Baseline/source                                       | Compared with/destination                                    | Writes                                                        |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `db diff`                        | `supabase/migrations/`                                | Live database (`--local` default, `--linked`, or `--db-url`) | stdout, or migration file(s) with `-f`                        |
| `db pull`                        | `supabase/migrations/` plus selected database history | Live database (`--linked` default)                           | migration file(s), then optionally selected database history  |
| `db pull --declarative`          | Selected live database                                | `supabase/database/`                                         | replaces the declarative tree; no migration or history update |
| `db schema declarative generate` | Selected live database                                | `supabase/database/`                                         | replaces declarative files only                               |
| `db schema declarative sync`     | `supabase/migrations/`                                | `supabase/database/`                                         | migration file(s), optionally applied to the local database   |

Normal diff mode always compares the migrations shadow with the selected live database. Declarative files under `supabase/database/` and `[db.migrations].schema_paths` do not replace the migrations baseline. If migrations are empty or outdated, a saved diff can therefore include objects already represented by declarative files. Use `supabase db schema declarative sync --no-apply` to generate and review a migration from the declarative desired state before making later live changes.

By default, all schemas in the target database are diffed. Use the `--schema public,extensions` flag to restrict diffing to a subset of schemas.

Projects created by a recent `supabase init` default to the pg-delta diff engine (`[experimental.pgdelta] enabled = true` in `config.toml`). Existing projects are unaffected and keep using migra unless they opt in. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]`, or pass `--use-migra` for a single run.

The pg-delta engine runs in-process by default and is bundled into the CLI together with pg-topo at build time. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily select the legacy edge-runtime implementation. `PGDELTA_NPM_REGISTRY`, `supabase/.temp/pgdelta-version`, and legacy catalogs under `supabase/.temp/pgdelta/` affect only that opt-out; there is no automatic fallback.

With the pg-delta engine the diff SQL is compacted and formatted by default with pg-delta's human-facing settings (lowercase keywords, wrapped at a max width of 180, indented and column-aligned); execution-aware transaction boundaries are preserved as per-unit header comments in the output. Configure partial overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw, unformatted statements. Compaction remains enabled in raw mode because it is a separate, semantics-preserving planning step.

The bundled and legacy renderers can produce different SQL bytes or file segmentation. The compatibility contract is executable SQL and convergence: after applying the result, a subsequent diff should be empty. With `PGDELTA_DEBUG=1`, bundled-engine snapshots, plans, and diagnostics are stored under `supabase/.temp/pgdelta/v2/debug/<id>/`; those files are diagnostic artifacts, not reusable catalogs.

While the diff command is able to capture most schema changes, there are cases where it is known to fail. Currently, this could happen if you schema contains:

- Changes to publication
- Changes to storage buckets
- Views with `security_invoker` attributes
