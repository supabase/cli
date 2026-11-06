# `supabase warehouse enable`

Target: hosted, consent default No — see [Command target](../../../../docs/command-target.md).

## Files and credentials

Uses the standard profile, access-token resolution, and linked-project target resolution. Reads the linked-project cache and project ref under `<workdir>/supabase/.temp/` when needed. Token lookup uses `SUPABASE_ACCESS_TOKEN`, the selected profile's keyring entry, then the credential-file fallback.

Best-effort linked-project caching runs after target resolution, including failures. Telemetry state is flushed on every handler exit. No Warehouse selection is stored locally.

## API routes

All requests use the selected profile's Management API and bearer token.

| Method | Path                                                            | Purpose                                                                                                          |
| ------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| POST   | `/v2/projects/{ref}/warehouse/setups/preview`                   | Read-only selection resolution before consent; returns table OIDs, schemas and names.                            |
| POST   | `/v2/projects/{ref}/warehouse/setups`                           | After consent, sends the selection and confirmed identities; creates or resumes managed replication and routing. |
| GET    | `/v2/projects/{ref}/warehouse/setups/current?inspect_fdw=false` | Only with `--wait`; polls initial synchronization, routing and replication state every two seconds.              |
| GET    | `/v1/projects`, `/v1/projects/{ref}`, branch-resolution routes  | Standard project picker, target resolution and best-effort linked-project cache.                                 |

Enablement does not install the FDW. Existing selections must match. Preview and consent refusal make no hosted writes. Setup is not rolled back on request failure or timeout; retrying the same selection is safe.

The command uses explicit `mode: "enable"` with a single schema/table target and confirmed preview identities. Status keeps UI table states separate from raw `replication_state`; completion requires copied/following-WAL observations, a started pipeline, and ready DNS. FDW inspection is disabled.

## Environment

Uses standard `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, and `SUPABASE_WORKDIR` resolution. `SUPABASE_YES` from the shell approves the hosted write; project `.env` files do not approve it.

## Output and exits

Supports `--output-format text|json|stream-json`. The legacy `--output` flag is rejected. Selection, confirmation and progress go to stderr. Structured success goes to stdout and distinguishes `accepted` from `synchronization_complete`.

Exit 0 means setup was accepted, or initial synchronization completed when `--wait` is set. Exit 1 covers invalid inputs, authentication and authorization failures, missing entitlement, declined or missing consent, stale previews, selection/lifecycle conflicts, network/response errors, replication failure, and wait timeout. Unavailable observations remain pending until the timeout.

## Telemetry and tracing

The command wrapper emits `cli_command_executed`; mapped entitlement errors retain the standard upgrade metadata. Schema and table flags are redacted. Spans cover the command, preview, apply and wait phases; annotations include the project ref, selected-table count and synchronization completion. Table names and SQL are not span attributes.
