# `supabase db remote commit`

## Files Read

| Path                                       | Format     | When                                                           |
| ------------------------------------------ | ---------- | -------------------------------------------------------------- |
| `~/.supabase/access-token`                 | plain text | when `SUPABASE_ACCESS_TOKEN` unset                             |
| `<workdir>/supabase/.temp/pgdelta-version` | plain text | pg-delta engine (the default) — overrides the pg-delta npm pin |

## Files Written

| Path                                                          | Format    | When                                                |
| ------------------------------------------------------------- | --------- | --------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_remote_commit.sql` | SQL       | always                                              |
| `<workdir>/supabase/.temp/pgdelta/debug/<id>/*`               | JSON/text | pg-delta engine with `PGDELTA_DEBUG` (debug bundle) |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                           | Purpose                                                                                 | Required?                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`            | auth token                                                                              | no (falls back to keyring → `~/.supabase/access-token`) |
| `DB_PASSWORD`                      | password for direct database connection                                                 | no                                                      |
| `PGDELTA_DEBUG`                    | pg-delta debug bundle capture                                                           | no                                                      |
| `PGDELTA_NPM_REGISTRY`             | pg-delta npm registry inside the edge-runtime container                                 | no                                                      |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | edge-runtime image registry                                                             | no                                                      |
| `SUPABASE_USE_SLIM_IMAGES`         | resolves the edge-runtime image from the slim `ghcr.io/supabase/cli/edge-runtime` build | no                                                      |

## Exit Codes

| Code | Condition                   |
| ---- | --------------------------- |
| `0`  | success                     |
| `1`  | database connection failure |
| `1`  | schema pull error           |

## Output

### `--output-format text`

Prints `Schema written to <path>` to stderr on success (from the shared
`pull.Run`, `internal/db/pull/pull.go:72`); no stdout confirmation message is
printed. The `Finished supabase db pull.` PostRun message belongs only to
`db pull` (`cmd/db.go:198-200`), not `db remote commit`.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Deprecated: use `db pull` instead.
- pg-delta is the default shadow-diff engine: the delegated Go binary runs the
  pg-delta scripts inside an edge-runtime container (pulled on demand), and the
  shadow diff replaces migra's. Rollback is `[experimental.pgdelta]
enabled = false` in `config.toml` — this command has no per-run engine flag.
- `--schema` / `-s` restricts the commit to specific schemas.
- `--db-url` and `--linked` (default true) are mutually exclusive.
