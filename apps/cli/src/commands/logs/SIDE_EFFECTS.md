# `supabase logs` and `supabase logs sources`

Both commands default to the local stack. `--remote` selects the linked project; `--remote=<ref|branch>` selects another project or a branch. Reads are consent-exempt. SQL requires a hosted target.

## Files read

- Shared settings and target resolvers read the CLI profile, project config, environment files, and `supabase/.temp/project-ref` with normal CLI precedence.
- Hosted reads resolve credentials from `SUPABASE_ACCESS_TOKEN`, the native keyring, or `<SUPABASE_HOME or ~/.supabase>/access-token`. Local reads do not resolve hosted credentials.
- `--file <path>` reads one UTF-8 SQL file relative to the resolved workdir. `--file -` reads non-TTY stdin and rejects terminal stdin immediately. These and `--sql` are mutually exclusive SQL inputs. Known SQL/filter/target incompatibilities and hosted time ranges are validated before SQL input or hosted target resolution. Only `--file -` consumes stdin; local and filtered commands leave it untouched. `--file` has no `-f` alias. Empty SQL, missing files, and failed stdin reads produce `LogsInputError` with actionable guidance.
- Local reads use the stack catalog and retained log files under `<SUPABASE_HOME or ~/.supabase>/stacks/`. Each load captures the selected segment generations and byte lengths before reading. Incomplete lines and later appends wait for another load. Local reads never launch, install, or mutate services.

## Files written

- Shared telemetry flushes `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on success and failure.
- Hosted target resolution registers linked-project cache finalization on success and failure. It may write `<workdir>/supabase/.temp/linked-project.json` under shared cache rules.

## API routes

| Method | Path                                          | Auth   | Request and response                                                                                                                      |
| ------ | --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/projects/{ref}/analytics/endpoints/logs` | Bearer | `sql`, `iso_timestamp_start`, and `iso_timestamp_end`; response `result` and `error`, both nullable. HTTP-200 query errors fail the load. |
| GET    | `/v1/projects`                                | Bearer | Shared interactive project picker.                                                                                                        |
| GET    | `/v1/projects/{parent}/branches`              | Bearer | Shared branch-name resolution.                                                                                                            |
| GET    | `/v1/branches/{id}`                           | Bearer | Shared branch UUID resolution.                                                                                                            |
| GET    | `/v1/projects/{ref}`                          | Bearer | Best-effort interactive project-name lookup (two-second timeout, no retries) and linked-project cache finalization.                       |

Each hosted load sends explicit UTC bounds. Hosted ranges cannot exceed 24 hours; local ranges have no 24-hour cap. `--to` alone selects the hour ending at that timestamp. SQL uses GET without a POST fallback or local SQL engine. `sources` makes no analytics request, though target resolution may use the picker or branch routes.

Filtered hosted refreshes stop after five successful pages of 1000 rows. This bounds each load against the analytics endpoint's rate limit of 10 requests per 60 seconds. A remaining page cursor, range start, and captured end persist as a pending continuation. `more pending` appears in the browser header; the next `L` continues that same range before advancing to a newer end. Each page retries HTTP 429 once after the greater of 60 seconds and `Retry-After`. Quitting cancels the wait. Exhausted failures preserve committed rows, cursor, and window.

No background polling runs. Interactive `L` starts one finite load through a newly captured time. The lower bound and target remain fixed. Filtered loads append unseen newer records; SQL reruns replace the result set. Failed loads preserve the previous browser rows and window. Local cursor state commits only after a successful read and emission pass. Local records after the captured end remain in their source files. Per-instance resume positions preserve them for a later load without a future-record memory buffer.

## Environment variables

Shared settings use `SUPABASE_HOME`, `SUPABASE_WORKDIR`, `SUPABASE_PROJECT_ID`, `SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, and standard telemetry configuration. Capability discovery follows `SUPABASE_EXPERIMENTAL_STACK` and `SUPABASE_EXPERIMENTAL_COMPUTE` with project config fallback. `CI` and `TERM` also control browser eligibility. No new environment variable is introduced.

## Exit codes

| Code | Condition                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | Successful finite read or browser quit.                                                                  |
| 1    | Input, feature gate, credential, transport, query, response decode, retained log, or truncation failure. |
| 130  | Browser interrupted with Ctrl-C.                                                                         |

A failed interactive load opens a wrapped, scrollable error panel. Up/down scrolls the full error, Escape restores the previous list or details, and L retries. Copy is disabled in the error panel. Failed loads preserve rows, selection, window, and pinned detail scroll.

## Telemetry

`cli_command_executed` uses `logs` and `logs sources`. SQL, paths, resource names, levels, and searches remain redacted. `LogsInputError` and `LogsApiError` retain declared actionability and committed error tags. HTTP errors retain their actual status. HTTP-200 query and response failures keep status 200 with distinct reasons. Transport failures retain their original HTTP client error instead of a synthetic server status.

## Output

`--output-format text|json|stream-json` selects native output. `-o/--output` is rejected before reads or target resolution.

Interactive text requires an omitted `--output-format`, terminal stdin and stdout, and interaction allowed. Explicit `--output-format text` reads once. CI disables the browser unless `CI` is empty, `0`, or `false` (case-insensitive); `TERM=dumb` also disables it. The browser reserves four header rows for count/status, target identity, active filters, and the requested window. Hosted identity shows project name and ref when available; the ref is the fallback. Local identity shows the selected stack. It shows compact UTC timestamps, service names, and messages. Color settings apply; a selection marker remains visible without color. Up/down selects rows, Enter opens scrollable details, Escape returns, C copies, L loads more logs, and q exits. Resize preserves selection. Selection and viewport stay stable after a reload where retention permits. Open details stay pinned to their record.

Filtered reads retain up to 1000 rows and approximately 8 MiB, with visible discarded-row counts. A single oversized record remains complete and is marked oversized. SQL preserves returned row order. Empty results keep the interactive browser open for another load. Raw input, resize listeners, cursor, screen, and background work are scoped to the viewer and restored on exit or failure.

`Window:` shows request metadata, independently of returned timestamps. A time filter shows its frozen start and the captured end. Local `--since start` names each service's latest launch and shows the captured end. A later successful load extends the end monotonically; a pending hosted continuation keeps its captured end until drained. An explicit `--to` applies to the first load.

Noninteractive reads finish after one pass. JSON returns a two-space-indented array. SQL stream JSON returns a `result` event. Filtered stream JSON emits `log-entry` and `log-marker` events with full records in `data`. Hosted records preserve IDs, source, severity, attributes, derived level, and timestamps. Their `service` is the catalog selector name; their raw table identifier remains in `source`. Local records preserve instance IDs, launch IDs, positions, and loss markers. Sources preserve their capability records in JSON output.

Filtered text wraps to terminal width on a TTY. Piped filtered text does not hard-wrap and escapes embedded carriage returns and newlines, preserving one event per line. SQL uses tables or wrapped vertical records. Page loading and rate-limit wait/retry-time notices appear in the browser footer; finite reads emit diagnostics to stderr. Text strips terminal control sequences from log fields.

## Clipboard

Unmodified c/C copies the selected full record, including metadata and its original timestamp. Details copy their pinned record even after retention evicts it. Empty lists do not copy. Clipboard text goes through subprocess stdin and never into arguments, errors, or telemetry.

macOS uses `pbcopy` with a UTF-8 locale. Windows uses a fixed UTF-8 PowerShell `Set-Clipboard` command. Linux tries `wl-copy`, `xclip -selection clipboard -in`, and `xsel --clipboard --input`. Successful background clipboard owners remain alive. Missing tools and clipboard failures show a status notice. Each copy has a three-second timeout; only one runs at once, and quitting cancels pending work. Pipes and machine output do not access the clipboard.

## Feature gates and compatibility

Compute filtered reads and discovery require the Compute feature. SQL does not require Compute. Local reads and discovery require the stack backend. Unsupported local level, search, and kind filters fail before log reads. Hosted levels derive from service fields; Compute app severity stays unknown. With `--level` and no service selector, hosted reads select `postgres`, `edge`, `auth`, `functions`, and `function-edge`. Local backend errors name `SUPABASE_EXPERIMENTAL_STACK=1`, `[experimental] stack = true`, and `--remote` as alternatives.

The deprecated `compute logs` and `stack logs` entrypoints keep their original flags, defaults, output modes, feature gates, and follow lifecycle. Their engines remain in their command directories; only shared time parsing, retained-history collection, gateway detection, and request transport have common owners. They warn once on stderr with `supabase logs` as the replacement and v4 as the removal version. The warning contains no interactive keyboard instructions. The legacy `-f` continues to mean `--follow`. Stack stream-json output adds `data` with the retained record; its JSON array keeps its existing shape. Legacy errors and lifecycle suggestions retain their shipping text.
