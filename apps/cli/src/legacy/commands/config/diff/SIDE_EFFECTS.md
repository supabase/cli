# `supabase config diff`

Read-only comparison between the local `supabase/config.toml` and the effective
configuration the Management API reports for a target project or branch.
Classifies every remotely-managed property as `update` / `remote_only` /
`local_only` (unmanaged local-only properties are never reported). **Never
writes `config.toml` or any remote configuration.**

## Files Read

| Path                                           | Format                    | When                                                                                       |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`               | TOML                      | always, before any network call (missing file or parse error aborts, exit 1)               |
| `<workdir>/supabase/.env`, `.env.local`        | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml`                              |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file); parent-ref for `--target` |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | existence check only, for the telemetry cache write below                                  |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                 |

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

| #   | Purpose                            | Method | Path                                 | Success | Notes                                                                  |
| --- | ---------------------------------- | ------ | ------------------------------------ | ------- | ---------------------------------------------------------------------- |
| 0a  | branch by UUID (`--target <uuid>`) | GET    | `/v1/branches/{branch_id}`           | 200     | only when `--target` is a UUID                                         |
| 0b  | branch by name (`--target <name>`) | GET    | `/v1/projects/{ref}/branches/{name}` | 200     | only when `--target` is not a ref/UUID; 404 → "branch not found" error |
| 1   | effective remote config            | GET    | `/v2/projects/{ref}/config`          | 200     | always (after target resolution)                                       |

## Environment Variables

| Variable                | Purpose                                                                                                               | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | project ref (flag → this → `.temp/project-ref` → prompt)                                                              | no                                                      |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | API profile selection                                                                                                 | no                                                      |
| `env(VAR)` references   | interpolated into `config.toml` values at load; a change on an env-resolved property names the variable in the output | no                                                      |

## Exit Codes

| Code | Condition                                                                      |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | success — including when differences are found, unless `--exit-code` is passed |
| `1`  | `--exit-code` passed and at least one difference found                         |
| `1`  | missing or malformed `supabase/config.toml`                                    |
| `1`  | `--target` and `--project-ref` passed together                                 |
| `1`  | unknown branch (`--target` 404)                                                |
| `1`  | two `[remotes.*]` blocks declare the same `project_id` as the target ref       |
| `1`  | remote config read failure (network or unexpected status)                      |

## Output

Diagnostics on **stderr**: `Comparing against …` (resolved target + local
scope, i.e. `[remotes.<name>]` or `base config`) before the fetch, then
`Comparison scope: <blocks>` listing the blocks the response carried (missing
blocks are called out). The payload is on **stdout**.

### `--output-format text`

One block per difference (`<path> [update|remote only|local only]` with
`local:`/`remote:` lines; unset renders `(unset)` / `(not returned)`,
env-resolved values append `(from env VAR)`), then a summary count line —
`No config differences found.` when clean — and a
`Note: N credential value(s) not compared (masked by the API): …` line when
the file sets masked secrets.

### `--output-format json` / `stream-json`

`output.success(message, payload)` with the payload containing
`schema_version`, `target` (`project_ref`, optional `branch`, `local_scope`),
`scope`, `changes[]` (`path`, `class`, `local`, `remote`, optional
`env_variable`; unset sides are `null`), `masked[]`, and `counts`
(per class + `total`).

### `-o/--output` (legacy machine formats)

Honored, and takes priority over `--output-format` (Legacy Shell Invariant
#6): `-o json|yaml|toml|env` encodes the same structured payload the
`--output-format json` envelope carries (TOML omits `null`-valued entries —
TOML has no null; env flattens to SCREAMING_SNAKE keys with arrays collapsing
to empty strings, the established `godotenv` shape). stdout is payload-pure in
every machine mode; diagnostics stay on stderr. `-o pretty` (and no `-o`)
falls through to `--output-format` handling.

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
  scope line rather than treated as an error.
