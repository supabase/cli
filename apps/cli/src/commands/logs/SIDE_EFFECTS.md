# `supabase logs query|tail|sources`

Target: `query` is hosted; `tail` and `sources` are selectable, default local. All reads are consent-exempt.

## Files read

- The shared command settings and target resolvers read the CLI profile, project config, project environment files, and `supabase/.temp/project-ref` using normal CLI precedence.
- Hosted reads resolve credentials from `SUPABASE_ACCESS_TOKEN`, the native keyring, or `<SUPABASE_HOME or ~/.supabase>/access-token`. Local reads do not resolve hosted credentials.
- `query --file` reads one UTF-8 SQL file relative to the resolved workdir. Query rejects an argument plus `--file`. With neither explicit input, query reads non-TTY stdin as the fallback; explicit inputs never consume stdin.
- Local reads use the existing stack catalog and retained log files under `<SUPABASE_HOME or ~/.supabase>/stacks/`. Runtime cache paths remain `<SUPABASE_HOME or ~/.supabase>/cache/stack/`. See [stack logs](../experimental/stack/logs/SIDE_EFFECTS.md).

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

- Query and sources: text tables by default; `-o pretty` and `-o table` force tables, `-o json` writes a JSON array, and `-o csv` writes CSV. Without `-o`, JSON output uses `Output.result` and stream-json emits a result event.
- Tail: text lines by default; `-o json`, `--output-format json`, and `--output-format stream-json` write one raw JSON record per line. `-o pretty` and `-o table` select text. Hosted rows preserve IDs, raw source/severity/attributes, derived level, and both ISO and millisecond timestamps. Local rows preserve the full stack log record, including instance IDs, positions, and markers.
- Explicit `-o` takes precedence. Unsupported output formats fail before analytics reads. Diagnostics and truncation notices use stderr. Text strips terminal control sequences from log fields.

## Notes

Hosted levels derive from verified source fields. Unsupported level/service combinations fail rather than filtering on a pipeline severity default. Compute app severity is unknown. Local level, search, and kind filtering are unsupported and fail before log reads. Source capabilities do not imply nonempty results. Hosted deduplication retains IDs within a two-minute overlap budget and stops if that budget exceeds 10000 IDs. Late arrivals outside the overlap may be absent.
