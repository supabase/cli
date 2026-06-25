# `supabase db schema declarative apply`

Applies existing declarative schema files directly to the local database using
pg-delta. It does not create a timestamped migration file and does not update
local migration history.

## Files

| Path                                                                                                                        | Kind | Condition                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| `<workdir>/supabase/database/**/*.sql` (declarative dir; configurable via `[experimental.pgdelta] declarative_schema_path`) | SQL  | must exist and is mounted read-only into the pg-delta container |

## External Processes

| Process                                                                                             | Condition                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `supabase-go db start` via the declarative seam                                                     | when the local database container is not running |
| Edge-runtime container (`supabase/edge-runtime`) running the pg-delta declarative-apply Deno script | always after validation                          |

## Exit Behavior

| Exit | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| `0`  | declarative schema applied successfully                                                           |
| `1`  | pg-delta disabled; no declarative files found; local database start failed; pg-delta apply failed |

## Output

Text output is written to stderr:

- `Applying declarative schemas via pg-delta...`
- `Applied <n> statements in <r> round(s).`

Apply failures include pg-delta's structured status summary before returning an
error.
