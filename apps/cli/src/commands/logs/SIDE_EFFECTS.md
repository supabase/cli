# `supabase logs` and `supabase logs sources`

Both commands default to the local stack. `--remote` selects the linked project; `--remote=<ref|branch>` selects another project or a branch. Reads are consent-exempt. SQL requires a hosted target.

## Files read

- Shared settings and target resolvers read the CLI profile, project config, environment files, and `supabase/.temp/project-ref` with normal CLI precedence.
- Hosted reads resolve credentials from `SUPABASE_ACCESS_TOKEN`, the native keyring, or `<SUPABASE_HOME or ~/.supabase>/access-token`. Local reads do not resolve hosted credentials.
- `--file` reads one UTF-8 SQL file relative to the resolved workdir. SQL must come from exactly one of `--sql`, `--file`, or non-TTY stdin. Explicit SQL inputs never consume stdin.
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
| GET    | `/v1/projects/{ref}`                          | Bearer | Best-effort linked-project cache finalization.                                                                                            |

Each hosted load sends explicit UTC bounds. Hosted ranges cannot exceed 24 hours. SQL uses GET without a POST fallback or local SQL engine. `sources` makes no analytics request, though target resolution may use the picker or branch routes.

No background polling runs. Interactive `L` starts one finite load through a newly captured time. The lower bound and target remain fixed. Filtered loads append unseen newer records; SQL reruns replace the result set. Failed loads preserve the previous browser rows and window. Local cursor state commits only after a successful read and emission pass. Future-dated local records wait in a bounded buffer; exceeding that budget fails without committing state.

## Environment variables

Shared settings use `SUPABASE_HOME`, `SUPABASE_WORKDIR`, `SUPABASE_PROJECT_ID`, `SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, and standard telemetry configuration. Capability discovery follows `SUPABASE_EXPERIMENTAL_STACK` and `SUPABASE_EXPERIMENTAL_COMPUTE` with project config fallback. No new environment variable is introduced.

## Exit codes

| Code | Condition                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | Successful finite read or browser quit.                                                                  |
| 1    | Input, feature gate, credential, transport, query, response decode, retained log, or truncation failure. |
| 130  | Browser interrupted with Ctrl-C.                                                                         |

A failed interactive reload shows a notice and leaves the browser usable.

## Telemetry

`cli_command_executed` uses `logs` and `logs sources`. SQL, paths, resource names, levels, and searches remain redacted. `LogsInputError` and `LogsApiError` retain declared actionability and committed error tags.

## Output

`--output-format text|json|stream-json` selects native output. `-o/--output` is rejected before reads or target resolution.

Interactive text requires terminal stdin and stdout with interaction allowed. The browser reserves two header rows for count/status and the requested window. It shows compact UTC timestamps, service names, and messages. Color settings apply; a selection marker remains visible without color. Up/down selects rows, Enter opens scrollable details, Escape returns, C copies, L loads more logs, and q exits. Resize preserves selection. Selection and viewport stay stable after a reload where retention permits. Open details stay pinned to their record.

Filtered reads retain up to 1000 rows and approximately 8 MiB, with visible discarded-row counts. A single oversized record remains complete and is marked oversized. SQL preserves returned row order. Empty results keep the interactive browser open for another load. Raw input, resize listeners, cursor, screen, and background work are scoped to the viewer and restored on exit or failure.

`Window:` shows request metadata, independently of returned timestamps. A time filter shows its frozen start and the captured end. Local `--since start` names each service's latest launch and shows the captured end. A later successful load extends the end monotonically. An explicit `--to` applies to the first load.

Noninteractive reads finish after one pass. JSON returns a two-space-indented array. SQL stream JSON returns a `result` event. Filtered stream JSON emits `log-entry` and `log-marker` events with full records in `data`. Hosted records preserve IDs, source, severity, attributes, derived level, and timestamps. Local records preserve instance IDs, launch IDs, positions, and loss markers. Sources preserve their capability records in JSON output.

Text wraps to terminal width, or 80 columns when unavailable. SQL uses tables or wrapped vertical records. Diagnostics use stderr. Text strips terminal control sequences from log fields.

## Clipboard

Unmodified c/C copies the selected full record, including metadata and its original timestamp. Details copy their pinned record even after retention evicts it. Empty lists do not copy. Clipboard text goes through subprocess stdin and never into arguments, errors, or telemetry.

macOS uses `pbcopy` with a UTF-8 locale. Windows uses a fixed UTF-8 PowerShell `Set-Clipboard` command. Linux tries `wl-copy`, `xclip -selection clipboard -in`, and `xsel --clipboard --input`. Successful background clipboard owners remain alive. Missing tools and clipboard failures show a status notice. Each copy has a three-second timeout; only one runs at once, and quitting cancels pending work. Pipes and machine output do not access the clipboard.

## Feature gates and compatibility

Compute filtered reads and discovery require the Compute feature. SQL does not require Compute. Local reads and discovery require the stack backend. Unsupported local level, search, and kind filters fail before log reads. Hosted levels derive from service fields; Compute app severity stays unknown.

The deprecated `compute logs` and `stack logs` entrypoints keep their original flags, defaults, output modes, feature gates, and follow lifecycle. They warn once on stderr with `supabase logs` as the replacement and v4 as the removal version.
