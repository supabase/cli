# `supabase config diff`

Read-only comparison between the local `supabase/config.toml` and the effective
configuration the Management API reports for a target project or branch.
Classifies every remotely-managed property as `update` / `remote_only` /
`local_only` (unmanaged local-only properties are never reported). **Never
writes `config.toml` or any remote configuration.**

## Files Read

| Path                                           | Format                    | When                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON                 | always, before any network call (`loadCliConfig` probes `config.json` first, then `config.toml` — a missing file or parse error aborts, exit 1, naming whichever file actually failed); re-read after target resolution when the file declares `[remotes.*]`, to apply the matching overlay |
| `<workdir>/supabase/.env`, `.env.local`        | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml`                                                                                                                                             |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file); parent-ref candidate for a branch-name `--project-ref` (checked eagerly, BEFORE any spinner or branch lookup)                            |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | parent-ref candidate for a branch-name `--project-ref` (same eager pre-check); existence-checked for the telemetry cache write below                                                                     |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                 |

## Files Written

| Path                                           | Format | When                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | `Effect.ensuring` after run (success **and** failure), if ref resolved |
| `~/.supabase/telemetry.json`                   | JSON   | `Effect.ensuring` after run (success **and** failure)                  |

**No writes to `supabase/config.toml` or `supabase/config.json`** — covered by
an integration test asserting mtime and contents are unchanged after a run
that finds differences.

## API Routes

All Bearer-authenticated, all read-only.

| #   | Purpose                 | Method | Path                                 | Success | Notes                                                                                                                                                                                              |
| --- | ----------------------- | ------ | ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a  | branch by UUID          | GET    | `/v1/branches/{branch_id}`           | 200     | only when `--project-ref` is a UUID; needs no linked project (no parent pre-check)                                                                                                                |
| 0b  | branch by name          | GET    | `/v1/projects/{ref}/branches/{name}` | 200     | only when `--project-ref` is a NAME (not a ref/UUID); the parent ref is resolved from local state BEFORE this call — an absent/invalid parent fails without making this request; 404 → "branch not found" |
| 1   | effective remote config | GET    | `/v2/projects/{ref}/config`          | 200     | always (after target resolution); 401/403/404 get purpose-written messages, other statuses the generic `unexpected status N: body` shape                                                          |

## Environment Variables

| Variable                | Purpose                                                                                                               | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | project ref (flag → this → `.temp/project-ref` → prompt)                                                              | no                                                      |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | API profile selection                                                                                                 | no                                                      |
| `env(VAR)` references   | interpolated into `config.toml` values at load; a change on an env-resolved property names the variable in the output | no                                                      |

## Exit Codes

Drift has its own exit code (`2`), distinct from every failure (`1`), so
`config diff --exit-code` scripts can tell "config drifted" from "token
expired" without parsing output (`terraform plan -detailed-exitcode`'s
convention; `1` stays the CLI-wide failure code). In **text mode only**, exit
2 is preceded by a stderr reason line, `Exiting 2: configuration differences
found (--exit-code).`, so a CI log never shows a bare "exit code 2" with no
explanation; machine mode (`--output-format json/stream-json`) never prints
it, keeping its bytes unchanged. The masked/unmanaged/not-returned-block
caveats never flip the exit code by themselves — only `changeSet.counts.total
> 0` (a real `update`/`remote_only`/`local_only` entry) does. Because
`run.ts` only runs its `afterSuccess` hooks (e.g. the upgrade notice) on exit
code `0`, a `--exit-code` run that exits `2` on drift suppresses that hook,
same as any other non-zero exit.

| Code | Condition                                                                       |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | success — including when differences are found, unless `--exit-code` is passed  |
| `2`  | `--exit-code` passed and at least one difference found                          |
| `1`  | the `-o`/`--output` global flag passed (any value — not supported by this command) |
| `1`  | missing or malformed `supabase/config.toml`/`config.json`                       |
| `1`  | branch-name `--project-ref` with no linked parent project (`LegacyConfigDiffBranchNotLinkedError`) |
| `1`  | branch-name `--project-ref` with a corrupt/invalid linked parent ref (`LegacyConfigDiffParentRefInvalidError`) |
| `1`  | unknown branch (branch-name `--project-ref` 404, `LegacyConfigDiffBranchNotFoundError`) |
| `1`  | resolved branch has no project ref yet — still provisioning (`LegacyConfigDiffBranchNotReadyError`) |
| `1`  | two `[remotes.*]` blocks declare the same `project_id` as the target ref        |
| `1`  | remote config read failure (network, 401/403/404, or other unexpected status)  |

## Output

Diagnostics on **stderr**: `Comparing against …` (resolved target + local
scope, i.e. `[remotes.<name>]` or `base config`) before the fetch, then
`Comparison scope: <blocks>` listing the blocks the response carried (missing
blocks are called out). The payload is on **stdout**.

### `--output-format text`

One block per difference (`<path> [update|remote-only|local-only]` with
`local:`/`remote:` lines; unset renders `(unset)` / `(not returned)`, an
undeclared path with a schema default renders `<value> (schema default — not
declared in config.toml)`, env-resolved values append `(from env VAR, …)`),
then a summary count line — `No config differences found.` when clean —
followed by a `Note: N block(s) … not returned by the API and … not compared:
…` line when the response omitted a block entirely, a `Note: … (masked by the
API): …` line when the file sets masked secrets, and a `Note: … cannot be
pushed and … not compared: …` line for declared properties push cannot
communicate. Every non-constant string (path segments, env-var names,
remotes/branch names) is sanitized against control characters before
rendering.

### `--output-format json` / `stream-json`

`output.success(message, payload)` — the message carries the not-returned/
masked/unmanaged caveats too, so echoing it never claims "in sync" on a
partial response (e.g. a scoped token returning `auth: {}`) or while masked
values may have drifted. The payload contains `schema_version` (integer
version of THIS payload contract, currently `1`), `config_schema` (the file's
`$schema` URL), `target` (`project_ref`, optional `branch`, `local_scope`),
`scope` (`{present, missing}` block lists — the block set is owned by
`@supabase/config`), `changes[]` (`path` as a SEGMENT ARRAY — a record key may
contain a `.` — plus `class`, `declared`, `local`, `remote`, optional
`env_variables[]`; unset sides are `null`), `masked[]` and `unmanaged[]`
(segment-array paths), and `counts` (per class + `total`).

### `-o/--output` (legacy machine formats)

**Not supported.** `config diff` is a net-new TS command with no Go parity
contract (CLI-2156, per Colum). Any `-o`/`--output` value — every
machine-format value AND `pretty` — is rejected outright
(`LegacyConfigDiffOutputFlagUnsupportedError`, exit 1) with:

```
the -o/--output flag is not supported by config diff; use --output-format json|stream-json instead.
```

Checked FIRST, before any config load, target resolution, or network call —
so a rejected invocation never burns a config read or an API round trip. The
command's own `withLegacyCommandInstrumentation` wiring widens the wrapper's
per-command `-o` enum to the full global choice set so every value (including
`table`/`csv`, which are otherwise only meaningful to `db query`) reaches this
handler-level rejection with its pointed message, rather than the wrapper's
generic pflag-style "invalid argument" rejection.

## Notes

- Run from the project root (or pass `--workdir`); `config.toml` is read relative to it.
- **Local operand per target (ADR 0018/0022):** when the resolved target ref matches a
  `[remotes.<name>]` block's `project_id`, the local side is that branch's merged
  effective config; otherwise the base config. The echoed scope line always says which.
- **Masked credentials:** secret-valued managed properties (the platform returns an HMAC,
  never plaintext; the registry's `isSecret` rows) are treated as "present, unknown" — never
  reported as differences and never counted for `--exit-code`; they are surfaced via the
  masked note / `masked[]`.
- **Values are convergence projections (ADR 0021):** both sides are normalized through
  `@supabase/config`'s `fromConfigDocument`/`fromApiProjectConfig`, so a reported "local"
  value is what pushing the file would produce hosted (canonicalized durations/byte sizes,
  push-gated omissions), not necessarily the file's literal spelling.
- **Partial responses:** a managed property the response does not carry is `local_only`
  when the file declares it and silent otherwise; a missing block is called out on the
  scope line, AND as a `Note:`/message caveat alongside the masked/unmanaged ones, rather
  than treated as an error.
