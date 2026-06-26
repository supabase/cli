# `supabase config push`

Pushes the local `supabase/config.toml` to the linked project's Management API.
Native Effect port of Go `internal/config/push` + `pkg/config` (api, db, auth,
storage, experimental). For each diffable service: GET remote → diff against
local → if changed, print the unified diff and confirm → PATCH/PUT/POST.

## Files Read

| Path                                             | Format                    | When                                                            |
| ------------------------------------------------ | ------------------------- | --------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                 | TOML                      | always, before any network call (parse error aborts, exit 1)    |
| `<workdir>/supabase/.env`, `.env.local`          | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml`   |
| Auth email template HTML (`content_path`)        | HTML                      | when `auth.enabled`; paths resolved per Go rules (see below)    |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON                      | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file) |
| `~/.supabase/access-token`                       | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable      |

## Files Written

| Path                                             | Format | When                                                                   |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | `Effect.ensuring` after run (success **and** failure), if ref resolved |
| `~/.supabase/telemetry.json`                     | JSON   | `Effect.ensuring` after run (success **and** failure)                  |

No writes to `config.toml`.

## API Routes

All Bearer-authenticated. Iterated in this order; a service is skipped (no GET)
when its local gate is off.

| #   | Service                 | Method | Path                                            | Success | Notes                                         |
| --- | ----------------------- | ------ | ----------------------------------------------- | ------- | --------------------------------------------- |
| 0   | cost matrix             | GET    | `/v1/projects/{ref}/billing/addons`             | 200     | raw HTTP; cost map for 1-variant addons       |
| 1   | api                     | GET    | `/v1/projects/{ref}/postgrest`                  | 200     |                                               |
| 1   | api                     | PATCH  | `/v1/projects/{ref}/postgrest`                  | 200     | only if diff present + kept                   |
| 2a  | db.settings             | GET    | `/v1/projects/{ref}/config/database/postgres`   | 200     | always processed (no gate)                    |
| 2a  | db.settings             | PUT    | `/v1/projects/{ref}/config/database/postgres`   | 200     |                                               |
| 2b  | db.network_restrictions | GET    | `/v1/projects/{ref}/network-restrictions`       | 200     | only if local `enabled`                       |
| 2b  | db.network_restrictions | POST   | `/v1/projects/{ref}/network-restrictions/apply` | 201     |                                               |
| 2c  | db.ssl_enforcement      | GET    | `/v1/projects/{ref}/ssl-enforcement`            | 200     | only if `[db.ssl_enforcement]` present        |
| 2c  | db.ssl_enforcement      | PUT    | `/v1/projects/{ref}/ssl-enforcement`            | 200     |                                               |
| 3   | auth                    | GET    | `/v1/projects/{ref}/config/auth`                | 200     | only if local `auth.enabled`                  |
| 3   | auth                    | PATCH  | `/v1/projects/{ref}/config/auth`                | 2xx     | MFA phone/webauthn gated by addon cost prompt |
| 4   | storage                 | GET    | `/v1/projects/{ref}/config/storage`             | 200     | only if local `storage.enabled`               |
| 4   | storage                 | PATCH  | `/v1/projects/{ref}/config/storage`             | 2xx     |                                               |
| 5   | experimental.webhooks   | POST   | `/v1/projects/{ref}/database/webhooks/enable`   | 2xx     | only if local `webhooks.enabled`; no GET/diff |

`UpdateSigningKeys` is **not** called by `config push`.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                               |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | project ref (flag → this → `.temp/project-ref` → prompt) | no                                                      |
| `SUPABASE_YES`          | auto-confirm prompts (`--yes`)                           | no                                                      |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                         | no (defaults to `https://api.supabase.com`)             |
| `SUPABASE_PROFILE`      | API profile selection                                    | no                                                      |
| `env(VAR)` references   | interpolated into `config.toml` values at load           | no                                                      |

## Exit Codes

| Code | Condition                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| `0`  | success, **including** declining a confirmation prompt (Go returns nil and continues)      |
| `1`  | malformed `config.toml`                                                                    |
| `1`  | invalid `auth.email.*.content_path` (missing/unreadable template file when `auth.enabled`) |
| `1`  | two `[remotes.*]` blocks declare the same `project_id` as the target ref                   |
| `1`  | list-addons failure (network or non-200)                                                   |
| `1`  | any per-service read/update failure (network or unexpected status)                         |

## Output

### `--output-format text` (Go CLI compatible)

All diagnostics on **stderr**, no stdout. When a `[remotes.<name>]` block matches the
target ref, `Loading config override: [remotes.<name>]` prints first. Then
`Pushing config to project: <ref>`, then
per service either `Remote <X> config is up to date.` or
`Updating <X> service with config: <unified diff>`; experimental prints
`Enabling webhooks for project: <ref>`. Confirmations render `<title> [Y/n] `
(or `<title> [Y/n] y` when `--yes`).

### `--output-format json` / `stream-json`

Per-service diagnostics stay on stderr; prompts auto-confirm (default yes). A
structured summary is emitted on stdout via `output.success("", data)`.

`json` mode — one flat object (note the empty `message` field added by
`output.success`):

```jsonc
{
  "project_ref": "abcdefghijklmnopqrst",
  "services": [{ "service": "api", "status": "updated" }],
  "message": "",
}
```

`stream-json` mode — an NDJSON `result` event with the payload nested under
`data` (consumers read `result.data.project_ref`, not `result.project_ref`):

```jsonc
{ "type": "result", "data": { "project_ref": "…", "services": […], "message": "" }, "timestamp": "…" }
```

`status ∈ "updated" | "up_to_date" | "skipped" | "disabled"`; dotted `service`
keys mirror `config.toml` paths.

## Notes

- Run from the project root (or pass `--workdir`); `config.toml` is read relative to it.
- Auth email `content_path` resolution (Go parity): `[auth.email.template.*]` paths are relative to the discovered project root; `[auth.email.notification.*]` paths are relative to `supabase/`. Notification HTML is read only when `enabled = true`.
- Diff bytes are byte-for-byte identical to the Go CLI (BurntSushi TOML encoder + anchored diff ports).
- Optional `*pointer` sections (`db.ssl_enforcement`, `storage.image_transformation`, `storage.s3_protocol`) are decoded as defaulted-present by `@supabase/config`; their true presence is recovered from the raw (merged) config document so they are skipped when absent, matching Go's nil-pointer behaviour.
- **`[remotes.*]` overrides are merged before push.** When a `[remotes.<name>]` block declares `project_id == <ref>`, `@supabase/config` merges that block's subtree over the base config at the raw (pre-decode) level — Go's `mergeRemoteConfig` (`apps/cli-go/pkg/config/config.go:550`) — so only the keys the block declares override the base. `Loading config override: [remotes.<name>]` prints to stderr. Two remotes sharing the target `project_id` abort with Go's `duplicate project_id for [remotes.<b>] and [remotes.<a>]` message.
- KNOWN GAPS:
  - **`encrypted:` (dotenvx) secret decryption is not reproduced.** The Go CLI decrypts `encrypted:` values before hashing and pushes the plaintext; we cannot decrypt here. Rather than push the ciphertext (which would overwrite the remote secret with garbage), `encrypted:` values are treated as unresolved — exactly like `env()` refs: they hash to `""`, so the empty hash gates them out of both the diff and the update body and the remote secret is left untouched.
