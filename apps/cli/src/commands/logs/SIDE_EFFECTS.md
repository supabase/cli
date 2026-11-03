# `supabase logs query|tail|sources`

Target: `query` is hosted; `tail` and `sources` are selectable, default local. All reads are consent-exempt.

## Files read

- The shared command settings and target resolvers read the CLI profile, project config, project environment files, and `supabase/.temp/project-ref` using normal CLI precedence.
- Hosted reads resolve credentials from `SUPABASE_ACCESS_TOKEN`, the native keyring, or `<SUPABASE_HOME or ~/.supabase>/access-token`. Local reads do not resolve hosted credentials.
- `query --file` reads one UTF-8 SQL file relative to the resolved workdir. Query rejects an argument plus `--file`. With neither explicit input, query reads non-TTY stdin as the fallback; explicit inputs never consume stdin.
- Local reads use the existing stack catalog and retained log files under `<SUPABASE_HOME or ~/.supabase>/stacks/`. Runtime cache paths remain `<SUPABASE_HOME or ~/.supabase>/cache/stack/`. The retained reader lives in `command-internal/stack-logs/`.

## Files written

- Shared telemetry flushes `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on success and failure.
- After a hosted query or tail resolves a ref, linked-project cache finalization runs on success and failure. It may write `<workdir>/supabase/.temp/linked-project.json` under the shared cache rules.
- Local reads never launch, install, or mutate services.

## API routes

| Method | Path                                          | Auth   | Request and response                                                                                                                                  |
| ------ | --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/projects/{ref}/analytics/endpoints/logs` | Bearer | Query params `sql`, `iso_timestamp_start`, `iso_timestamp_end`; response `result` and `error`, both nullable. HTTP-200 query errors fail the command. |
| GET    | `/v1/projects`                                | Bearer | Shared project picker when no ref resolves interactively.                                                                                             |
| GET    | `/v1/projects/{parent}/branches`              | Bearer | Shared branch-name resolution.                                                                                                                        |
| GET    | `/v1/branches/{id}`                           | Bearer | Shared branch UUID resolution.                                                                                                                        |
| GET    | `/v1/projects/{ref}`                          | Bearer | Best-effort shared linked-project cache finalization.                                                                                                 |

`query` accepts arbitrary hosted log SQL without a Compute feature gate. `tail` sends one history request unless `--tail 0`, then polls every 10 seconds. Polls read at most 1000 rows and fail if the response reaches that size. HTTP 429 and server failures retry at 10-second intervals for up to one minute. Both time bounds are always sent; ranges longer than 24 hours fail before a request. No POST fallback or local SQL engine exists.

`sources` lists capabilities and makes no analytics request. Target selection can still resolve a hosted branch or invoke the project picker. Compute source discovery and tailing require the Compute feature flag. Local discovery and tailing require the stack backend.

## Environment variables

Shared settings use `SUPABASE_HOME`, `SUPABASE_WORKDIR`, `SUPABASE_PROJECT_ID`, `SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, and standard telemetry configuration. Experimental capability discovery follows `SUPABASE_EXPERIMENTAL_STACK` and `SUPABASE_EXPERIMENTAL_COMPUTE` with project config fallback. No new environment variable is introduced.

## Exit codes

| Code | Condition                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 0    | Successful bounded read or SIGTERM follow shutdown                                                      |
| 1    | Input, feature gate, credential, transport, query, response decode, retained log, or truncation failure |
| 130  | Hosted follow interrupted by SIGINT                                                                     |

Local follow preserves the existing stack process-signal behavior.

## Telemetry events fired

`cli_command_executed` uses the canonical `logs query`, `logs tail`, and `logs sources` paths through the command wrapper. Free-form SQL, paths, resource names, levels, and searches remain redacted. `LogsInputError` and `LogsApiError` have declared actionability and committed error tags.

## Output

`--output-format text|json|stream-json` selects native output. Every `-o/--output` value is rejected with guidance to use `--output-format` before reads or target resolution.

- Query and sources: text tables by default; JSON writes a result array, and stream JSON emits one `result` event containing that array.
- Tail: text lines by default. With `--no-follow`, JSON writes an array of full hosted or local records. Following with JSON fails before any reads and points to `--output-format stream-json`.
- Tail stream JSON emits standard `log-entry` and `log-marker` events with timestamp, service, and history/live source. Their JSON-object `data` field preserves the full record. Hosted rows keep IDs, source, severity, attributes, derived level, and ISO/millisecond timestamps. Local rows keep instance IDs, launch IDs, positions, and loss markers.
- Diagnostics and truncation notices use stderr. Text strips terminal control sequences from log fields.

## Targets and feature gates

`tail` and `sources` use implicit local targeting. `--remote` selects the linked hosted project; `--remote=<ref|branch>` selects another project or a branch. Hidden deprecated selector aliases follow the shared v3 target conventions. `query` uses hosted target flags and has no `--local` flag.

Compute feature discovery resolves project config and environment overrides for `logs tail` and `logs sources`. A disabled feature excludes Compute capabilities; a true override includes them. Generic `logs query` does not resolve or require the Compute feature. The retired experimental `compute logs` and `stack logs` leaves are not registered.

## Notes

Hosted levels derive from verified source fields. Unsupported level/service combinations fail rather than filtering on a pipeline severity default. Compute app severity is unknown. Local level, search, and kind filtering are unsupported and fail before log reads. Source capabilities do not imply nonempty results. Hosted deduplication retains IDs within a two-minute overlap budget and stops if that budget exceeds 10000 IDs. Late arrivals outside the overlap may be absent.
