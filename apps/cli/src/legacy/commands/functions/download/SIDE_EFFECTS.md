# `supabase functions download [Function name]`

## Files Read

| Path                       | Format     | When                                                       |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path                                                | Format | When                                     |
| --------------------------------------------------- | ------ | ---------------------------------------- |
| `<workdir>/supabase/functions/<slug>/<remote path>` | bytes  | for each source file returned by the API |

## API Routes

| Method | Path                                       | Auth         | Request body | Response (used fields)                     |
| ------ | ------------------------------------------ | ------------ | ------------ | ------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/functions`             | Bearer token | none         | function slugs, when downloading all       |
| `GET`  | `/v1/projects/{ref}/functions/{slug}`      | Bearer token | none         | entrypoint path, when absent from metadata |
| `GET`  | `/v1/projects/{ref}/functions/{slug}/body` | Bearer token | none         | multipart function source                  |

## Subprocesses

| Command                              | When                                                              | Purpose                             |
| ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------- |
| `supabase-go functions download ...` | `--use-docker` (default) or `--legacy-bundle`, unless `--use-api` | preserve hidden compatibility modes |

The delegated call runs with `SUPABASE_TELEMETRY_DISABLED=1` so the Go child's
own `cli_command_executed` doesn't double-count on top of this command's own
telemetry (mirrors `db pull`/`db diff`'s delegated-call pattern). In
`--output-format json|stream-json`, the child's stdout is captured and
discarded instead of inherited (`LegacyGoProxy.execCapture`) — the raw text
never reaches the terminal, and this command emits the `Output` envelope
itself once the child exits successfully.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |

## Exit Codes

| Code | Condition                              |
| ---- | -------------------------------------- |
| `0`  | success                                |
| `1`  | API error (non-2xx response)           |
| `1`  | authentication error (no token found)  |
| `1`  | network / connection failure           |
| `1`  | invalid function slug or flag conflict |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress and success messages as functions are downloaded.

### `--output-format json`

Prints a structured success result with the downloaded function slugs and project ref. On the
Docker/legacy-bundle proxy path, the Go child's stdout is captured/discarded (never inherited) so
it can't corrupt the envelope; the slug list is resolved independently for the payload.

### `--output-format stream-json`

Same envelope as `json` above (including on the proxy path).

## Notes

- If no function name is provided, downloads all functions.
- Requires a linked project (`--project-ref` or linked project config).
- Native downloads reject path traversal and symlink escapes before writing source files.
- `--use-docker` and `--legacy-bundle` are hidden flags forwarded to the Go binary for backward compatibility; they are mutually exclusive with `--use-api`.
- `--use-docker` defaults to `true` (Go parity), so a bare `supabase functions download` proxies to the Go binary's Docker-based unbundler unless `--use-api` resolves to `true`, which forces the native server-side download path instead (`apps/cli-go/cmd/functions.go:51-53`: `if useApi { useDocker = false }` reads the resolved flag value, not presence — `--use-api=false` still proxies).
- If Docker is not running, the Go binary itself prints `WARNING: Docker is not running` to stderr and falls back to its own server-side unbundler — the command still exits `0` without Docker installed or running.
- The mutual-exclusivity check only counts flags the user explicitly passed on the command line, not `--use-docker`'s default value — so `--use-api` alone never trips the "mutually exclusive" error. The Go proxy call itself also only ever forwards one of `--use-docker`/`--legacy-bundle`, never both, even though `--use-docker` defaults to `true`.
- Refreshes the linked-project telemetry cache and flushes telemetry state after resolving a project ref.
