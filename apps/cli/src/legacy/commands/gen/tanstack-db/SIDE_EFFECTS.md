# `supabase gen tanstack-db`

> TS-only command — no Go CLI equivalent. See `docs/go-cli-porting-status.md` → "TS-only Commands".

## Files Read

| Path                             | Format     | When                                                                                                             |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` / `--project-id` / the implicit linked fallback resolves a ref |
| `<workdir>/supabase/config.toml` | TOML       | `--local` (required — fails if missing); best-effort otherwise to resolve default `--schema` values              |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

No files are written. The generated TanStack DB + Zod file is printed to stdout; the user redirects it to a file themselves (e.g. `supabase gen tanstack-db --linked > lib/tanstack-db.ts`), matching `supabase gen types`.

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)                              |
| ------ | ------------------------------------- | ------------ | ------------ | --------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/database/openapi` | Bearer token | none         | `definitions` (PostgREST OpenAPI table definitions) |

Called once per requested `--schema` value (default `public`) for `--linked`, `--project-id`, and the implicit linked-project fallback. `--local` does not call the Management API — instead it calls the local stack's own PostgREST gateway directly (see below).

## Local Stack Requests

| Method | URL                                    | Headers                                                                                                          | When                                 |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET`  | `http://127.0.0.1:<api.port>/rest/v1/` | `apikey`, `Accept-Profile: <schema>`, and `Authorization: Bearer <key>` unless the key is a new-style `sb_…` key | `--local`, once per requested schema |

The `apikey`/bearer value is `auth.publishable_key` (falling back to `auth.anon_key`, then the local stack's default publishable key) from `supabase/config.toml`.

## Environment Variables

| Variable                | Purpose                                                        | Required?                                               |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` / `--project-id` / implicit fallback | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                        | no (falls back to `~/.supabase/profile` -> `supabase`)  |

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success — generated file printed to stdout                                  |
| `1`  | no target specified (must use one of `--local`, `--linked`, `--project-id`) |
| `1`  | mutually exclusive flags combined (`--local`/`--linked`/`--project-id`)     |
| `1`  | `supabase/config.toml` not found (`--local`)                                |
| `1`  | local stack unreachable (`--local`, "supabase start is not running.")       |
| `1`  | Management API error (network or non-2xx status)                            |
| `1`  | a table has no primary key column                                           |
| `1`  | no tables found in the selected schema(s)                                   |

## Output

### `--output-format text` (only supported mode)

Prints the generated TypeScript file (Zod schemas + TanStack DB collections, one pair per table) to stdout. Diagnostics, if any, go to stderr.

### `--output-format json` / `stream-json`

Not applicable — this is a TS-only command and does not model structured output modes; it always emits the raw generated file to stdout regardless of `--output-format`.

## Notes

- Exactly one of `--local`, `--linked`, or `--project-id` may be specified; when none is given, the linked project is used as a fallback (same resolution order as `gen types`), minus `--db-url`, which has no PostgREST endpoint to introspect.
- `--schema` / `-s` accepts a comma-separated list, repeatable; defaults to the project's configured `api.schemas` (always includes `public`). One OpenAPI document is fetched per schema and the table sets are merged; a table name present in more than one requested schema is last-write-wins.
- A table's primary key is detected from PostgREST's `Note:\nThis is a Primary Key.<pk/>` OpenAPI property description, falling back to a literal `id` column. A composite primary key produces a `keys` array with all of its columns.
- The generated file imports from `zod`, `@tanstack/db`, `@supabase-labs/tanstack-db`, and `@supabase/supabase-js`, and expects `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables — none of these are installed or configured by this command.
