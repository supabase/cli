# `supabase domains [create|get|reverify|activate|delete]`

Custom hostname management. Every subcommand resolves a project ref and calls a
single Management API custom-hostname endpoint. `create` additionally performs a
Cloudflare DNS-over-HTTPS CNAME pre-check.

## Files Read

| Path                                   | Format                    | When                                                       |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/supabase/.temp/project-ref` | plain text                | when `--project-ref` flag and `PROJECT_ID` env are unset   |

## Files Written

| Path                                             | Format | When                                               |
| ------------------------------------------------ | ------ | -------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (PersistentPostRun), after the ref resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (PersistentPostRun), success or failure     |

## API Routes

| Method   | Path                                            | Auth         | Request body                | Response (used fields)                                                                       |
| -------- | ----------------------------------------------- | ------------ | --------------------------- | -------------------------------------------------------------------------------------------- |
| `GET`    | `https://1.1.1.1/dns-query?name=<host>&type=5`  | none         | none                        | `{Answer: [{type, data}]}` — first CNAME answer (`create` only, before the POST)             |
| `POST`   | `/v1/projects/{ref}/custom-hostname/initialize` | Bearer token | `{custom_hostname: string}` | 201 → `{status, custom_hostname, data: {result: {ssl, custom_origin_server, …}}}` (`create`) |
| `GET`    | `/v1/projects/{ref}/custom-hostname`            | Bearer token | none                        | 200 → same response shape (`get`)                                                            |
| `POST`   | `/v1/projects/{ref}/custom-hostname/reverify`   | Bearer token | none                        | 201 → same response shape (`reverify`)                                                       |
| `POST`   | `/v1/projects/{ref}/custom-hostname/activate`   | Bearer token | none                        | 201 → same response shape (`activate`)                                                       |
| `DELETE` | `/v1/projects/{ref}/custom-hostname`            | Bearer token | none                        | 200 → empty/void body (`delete`)                                                             |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)  |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset   | no (falls back to linked-project file)                   |
| `SUPABASE_PROFILE`      | built-in profile name or path to a YAML profile      | no (defaults to `supabase`; sets API URL + project host) |

## Exit Codes

| Code | Condition                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | success                                                                         |
| `1`  | project ref cannot be resolved / is malformed                                   |
| `1`  | `create`: hostname has no matching CNAME record (Cloudflare DNS pre-check)      |
| `1`  | API error — unexpected (non-201/200) response from the custom-hostname endpoint |
| `1`  | network / connection failure                                                    |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                    |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (all redacted — Go marks no `domains` flag telemetry-safe) |

No custom events: the Go `internal/hostnames` package emits no `phtelemetry.*` calls.

## Output

In `pretty`/text mode the `PrintStatus` text is written to **stderr** and nothing
to stdout. In a structured `-o` mode (`json`/`yaml`/`toml`/`env`) the encoded
response goes to **stdout** and the human status is suppressed on stderr (see the
divergence note below). `delete` only prints a fixed success line to stderr and
ignores `-o`.

### `--output-format text` (Go CLI compatible)

stderr carries the status message for the hostname's current state, e.g.:

```
Custom hostname configuration not started.
```

`delete` prints `Deleted custom hostname config successfully.` to stderr. stdout is empty in text mode.

### `--output-format json`

Single JSON object (the full custom-hostname response) emitted via `output.success`.
`delete` emits `{}` with the success message.

### `--output-format stream-json`

A `result` event carrying the custom-hostname response object.

### Go `-o {json,yaml,toml,env}`

When the Go `--output`/`-o` flag is set (or `--include-raw-output` forces `json`),
the full response is encoded to stdout in that format and the human status is
suppressed on stderr. `delete` ignores `-o`.

## Notes

- `--custom-hostname` is required for `create`.
- `create` validates the CNAME via Cloudflare DNS-over-HTTPS (`https://1.1.1.1`, 10s timeout) before initializing; on failure it short-circuits before any POST.
- All subcommands resolve the ref via `--project-ref` → `PROJECT_ID` env → linked-project file, matching Go.
- The project-ref fallback env var is `SUPABASE_PROJECT_ID`, matching Go (Go calls `viper.GetString("PROJECT_ID")` under `viper.SetEnvPrefix("SUPABASE")`, which resolves to the `SUPABASE_PROJECT_ID` environment variable).
- **Documented divergences from Go (intentional):**
  - `--include-raw-output` is declared as a normal boolean **on each subcommand** (Go declares it as a persistent flag on the `domains` group). Two consequences: (a) it must appear after the subcommand name (`domains get --include-raw-output`) rather than before it (`domains --include-raw-output get`), matching how `--project-ref` is already handled shell-wide; (b) it cannot reproduce Cobra's help-hiding or the `Flag --include-raw-output has been deprecated` stderr warning, which Effect CLI has no hook for. It still reproduces the behavioral effect (forces `-o json` when `-o` is unset/pretty); on `delete` it is inert, matching Go.
  - `-o json|yaml|toml|env` encode the decoded snake_case response, not Go's PascalCase struct keys (consistent with `backups list` / `sso add`).
  - The degenerate `validation_records != 1` status message approximates Go's `%+v` struct dump (which embeds a non-deterministic pointer address).
  - Text-mode status output is newline-terminated even for Go's `Fprintf` branches. Without the final newline, interactive shell prompts can redraw over the last status line, hiding the ACME TXT record.
  - In a structured `-o` mode the human status is suppressed on stderr. Go technically still writes `PrintStatus` to stderr, but the `5_*`/`4_*` messages carry no trailing newline, so they fuse with Go's version-update notice and are stripped together by the e2e normalizer — making Go's observable machine-output stderr empty. Suppressing keeps stdout clean and matches the parity contract.
