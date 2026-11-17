# `supabase warehouse teardowns get`

Target: hosted. This read-only command requires the Warehouse family feature gate and no mutation
consent. It calls `GET /v2/projects/{ref}/warehouse/teardowns/current` with the required
`operation_id` query flag and bearer authentication. The server checks database-read permission
and OAuth scope, then reads durable primary metadata without checking source health, ETL or FDW.

Piped/agent output and explicit JSON modes preserve the raw JSON response; `-o yaml` encodes
the same document. Interactive terminals use the shared text renderer. Unknown and null
observations remain unchanged in machine output. `--wait` repeats this read until `disabled` or `deletion_failed`,
with the shared backoff and bounded timeout. A replaced or cleared operation fails with a conflict.
Polling does not modify Warehouse state. `--dry-run` prints only the local request, without a
status read.

The local config/profile/auth reads, linked-project cache, telemetry writes, output, wait-error
context and exit codes are shared with [warehouse disable](../../disable/SIDE_EFFECTS.md).
It does not write project config or read stdin. Post-run best-effort cache requests and telemetry
flushes still run on success, dry-run or failure.
