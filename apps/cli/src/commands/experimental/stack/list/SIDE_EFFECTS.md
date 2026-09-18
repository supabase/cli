# `supabase stack list`

Lists every persisted managed local stack. The command is registered only when the
`experimental.stack` family is enabled; that gate also controls help and completion. It reads
the registry without loading a project configuration, contacting an owner, or changing a
lifecycle.

## Files Read

| Path                                                           | Format          | When                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json`              | TOML or JSON    | During the `experimental.stack` family gate when `SUPABASE_EXPERIMENTAL_STACK` is unset or empty; the nearest project is discovered from the default workdir, while explicit `--workdir`/`SUPABASE_WORKDIR` is used as given.                                  |
| `<SUPABASE_HOME or ~/.supabase>/profile`                       | plain text      | By shared `CommandSettings` when `--profile` and `SUPABASE_PROFILE` are unset; an empty or missing file selects `supabase`.                                                                                                                                    |
| Value of `--profile`, `SUPABASE_PROFILE`, or persisted profile | YAML profile    | By shared `CommandSettings` when the selected profile is not a built-in name; an unreadable, malformed, or invalid explicit profile fails the command.                                                                                                         |
| `<workdir>/supabase/config.toml`                               | existence probe | By shared `CommandSettings` while resolving a default workdir from its ancestor directories. The list handler does not perform a full project config load.                                                                                                     |
| `<SUPABASE_HOME or ~/.supabase>/stacks/`                       | directory       | Registry enumeration. Entries that are not stack IDs are ignored.                                                                                                                                                                                              |
| `<SUPABASE_HOME or ~/.supabase>/stacks/<stack-id>/state.json`  | JSON            | Each stack ID entry; readable descriptors use `identity.projectRoot`, `identity.stackName`, `identity.branchContext`, `runtime`, and `desiredLifecycle`; missing state files are ignored as remnants; decode or validation failures remain unreadable entries. |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`                | JSON            | Shared telemetry state load, regardless of telemetry delivery being enabled.                                                                                                                                                                                   |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                               |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | Once the handler is entered, always best-effort through its flush finalizer, on success and failure, including when telemetry is disabled. Startup or profile-resolution failures can occur before this finalizer. |

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                        |
| ------ | ---- | ---- | ------------ | ----------------------------------------------------------------------------- |
| —      | —    | —    | —            | No Management API calls or owner RPCs; shared telemetry delivery is separate. |

## Environment Variables

| Variable                      | Purpose                                                                                                     | Required?                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_EXPERIMENTAL_STACK` | Family registration (`1` enable, `0` disable; unset/empty uses project config; other values fail selection) | no                                                             |
| `SUPABASE_HOME`               | Global registry, profile, and telemetry root                                                                | no (falls back to `~/.supabase`)                               |
| `SUPABASE_PROFILE`            | Built-in profile name or YAML profile path                                                                  | no (falls back to the persisted profile file, then `supabase`) |
| `SUPABASE_WORKDIR`            | Explicit workdir for shared settings and feature discovery                                                  | no (used after `--workdir`, then ancestor probes from CWD)     |
| `SUPABASE_TELEMETRY_DISABLED` | Suppresses telemetry delivery while retaining telemetry state persistence                                   | no                                                             |
| `DO_NOT_TRACK`                | Suppresses telemetry delivery while retaining telemetry state persistence                                   | no                                                             |

## Exit Codes

| Code | Condition                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Registry enumeration succeeds, including readable entries, unreadable entries, only unreadable entries, and a fully empty registry. |
| `1`  | Registry root existence/read failure, mapped to `StackCommandListError` with `invalid-config`.                                      |
| `1`  | The legacy `-o/--output` flag is supplied; use `--output-format json`, `text`, or `stream-json`.                                    |
| `1`  | Shared profile loading or explicit feature selection fails.                                                                         |

## Telemetry Events Fired

| Event                  | When                                                                | Notable properties / groups                                                        |
| ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `cli_command_executed` | Post-run, success or failure, through the command telemetry wrapper | `exit_code`, `duration_ms`, command flags, run identity; capture is consent-gated. |

No custom events are emitted.

## Output

Readable entries retain `id`, `project_root`, `name`, `branch_context`, `runtime`, and
`desired_lifecycle`, plus `readable: true`. Unreadable entries contain only `id`, `readable: false`,
and `error: {code, message}`; no metadata is inferred from a failed state document. Readable
entries sort by project root, name, and ID. Unreadable entries follow them, sorted by ID.

### `--output-format text`

Readable entries show a table with NAME, PROJECT, BRANCH, RUNTIME, DESIRED, and a compact ID.
Every unreadable entry is shown in a diagnostic section with its error code and the package-enriched
message carrying its full ID. Underlying filesystem diagnostics may also contain paths with that ID.
The `No managed stacks found.` message is emitted only when both readable and unreadable entry arrays
are empty.

### `--output-format json`

The success data contains a single `stacks` array with the discriminated entries described above.
The shared `Output.success` JSON envelope also carries its empty `message` field:

```json
{
  "stacks": [
    {
      "id": "…",
      "readable": true,
      "project_root": "…",
      "name": "…",
      "branch_context": "…",
      "runtime": { "kind": "native" },
      "desired_lifecycle": "stopped"
    },
    { "id": "…", "readable": false, "error": { "code": "StackStateInvalidError", "message": "…" } }
  ],
  "message": ""
}
```

### `--output-format stream-json`

One `result` NDJSON event contains the same complete `{stacks: [...]}` success data (plus the
shared empty `message` field). Per-entry issues are successful enumeration and therefore do not
emit an error event or change the exit code.
