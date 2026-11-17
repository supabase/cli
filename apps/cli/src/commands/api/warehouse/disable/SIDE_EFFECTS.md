# `supabase warehouse disable`

Target: hosted. Consent defaults to No; noninteractive mutations require `--yes` or shell
`SUPABASE_YES`. Registration requires `experimental.warehouse` in project config or
`SUPABASE_EXPERIMENTAL_WAREHOUSE=1`.

## Requests and retention

`DELETE /v2/projects/{ref}/warehouse` starts asynchronous cleanup. Omitted `--delete-data` retains
Warehouse data; `--delete-data` sends `delete_data=true` and permanently deletes the managed
catalog schema and dedicated Storage bucket. Source Postgres tables and legacy shared buckets
remain. The server checks source administrator/database permissions and entitlement, plus
destination SQL/Storage write permissions for data deletion.

Both modes stop replication and remove the Warehouse publication, FDW and dependent foreign
tables, reader group, external catalog access and query routing. Acceptance does not mean these
effects have completed. Reader memberships must be granted again after re-enablement.

The response contains the cleanup identity in `data.id`, with `lifecycle_status`, `delete_data`,
`updated_at` and nullable `cleanup_error` in `data.attributes`. Safe retries return the current
operation; the server rejects a changed in-progress data policy. Failed cleanup can be partial.

`--wait` follows the response link to
`GET /v2/projects/{ref}/warehouse/teardowns/current?operation_id=<accepted-id>`.
It uses the shared bounded poller: 1s exponential backoff, capped at 10s, honoring a longer
`Retry-After`. The default timeout is 10m. `disabled` succeeds and `deletion_failed` fails.
Polling uses durable metadata, without an ETL, FDW or source-health dependency. A replaced or
cleared operation returns a conflict. Timeout and cancellation stop local polling only.

`warehouse teardowns get --remote=<ref>` reads current cleanup without an operation ID.
`warehouse teardowns get --operation-id <accepted-id> --wait --remote=<ref>` resumes observation
of the accepted disable attempt; `disable --wait` always passes this ID through its response link.
That command is read-only and needs no mutation consent. It accepts the same `--timeout` and
output options and requires database-read permission.

## Local effects and output

The generated runtime uses the same config, auth/profile, target resolution, linked-project cache,
and telemetry reads/writes as [warehouse enable](../enable/SIDE_EFFECTS.md). Neither command
writes source configuration or executes SQL locally. Command telemetry records generated field
values as redacted; neither cleanup responses nor error contents become telemetry properties.

Piped and agent runs, `--output-format json|stream-json`, and `-o json` write the raw API JSON
response to stdout, preserving unknown and null fields. An interactive terminal renders the
shared text view unless an output mode is selected; `-o pretty` also selects text. `-o yaml` writes the same document as YAML. With `--wait`, stdout contains the terminal read.
Errors use the standard stderr envelope. `wait_timeout` includes `timeout_ms`, nullable
`last_status`, and the command for resuming observation; terminal text includes the last status.
`operation_failed` includes the failed status and reported cleanup error.

`--dry-run` prints only the local request in the selected text/JSON/YAML presentation, with the
chosen deletion query, before
consent and without a command request. The post-run best-effort linked-project cache read may
still run. This is not a resolved impact preview; server preview/apply and revision checks remain
follow-up work. Consent uses the operation summary; it does not render a deletion-specific impact
plan. Permanent deletion is described in command and flag help.

Exit 0 means acceptance, completed waiting or dry-run. Standard API/wait errors exit 1, invalid
usage or missing noninteractive consent exits 2, and cancellation exits 130.
