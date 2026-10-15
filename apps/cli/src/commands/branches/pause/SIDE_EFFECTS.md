# `supabase branches pause`

## Files Read

Same auth fallback chain as every Management-API command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                             | Format | When                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method | Path                                 | Auth         | When                                                           | Response          |
| ------ | ------------------------------------ | ------------ | -------------------------------------------------------------- | ----------------- |
| `GET`  | `/v1/projects/{ref}/branches/{name}` | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern | `{project_ref}`   |
| `GET`  | `/v1/branches/{branch_id_or_ref}`    | Bearer token | branch input is a UUID                                         | `{ref}`           |
| `POST` | `/v1/projects/{branch_ref}/pause`    | Bearer token | always — final pause action                                    | none (expect 200) |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list` (including the CLI-2167 PARENT-scoped resolution chain).

`SUPABASE_YES` — approves the hosted-mutation confirmation like `--yes`; read from the shell environment only, never `supabase/.env`.

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — branch paused                                                                                                |
| `1`  | `BranchesPauseUnexpectedStatusError` — non-200 response from pause endpoint                                            |
| `1`  | `BranchesPauseNetworkError` — transport-level network failure                                                          |
| `1`  | Branch-id resolution errors (find / config endpoints failed)                                                           |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Silent on success in every mode (the handler writes nothing itself; the target banner and any `Confirmed by --yes` line go to stderr). The prompt helper may write `Selected branch ID: <ref>` to stderr in text mode if the TTY picker was used.

## Notes

- Resolves the parent project and prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after the branch name or ID is resolved to its ref and before the API write, with default No: `Pause preview branch <name-or-id>`. The question also shows the branch project ref. `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.
