# `supabase config push`

Pushes the local `supabase/config.toml` to the linked project's Management API.
For each diffable service: GET remote → diff against local → if changed, print
the unified diff and confirm → PATCH/PUT/POST.

## Files Read

| Path                                           | Format                    | When                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML                      | always, AFTER the target ref is resolved (branch/UUID resolution's own network call, when it applies, runs first — see Notes) — with the resolved ref passed in the SAME `loadCliConfig` call so a matching `[remotes.<name>]` block's overlay is merged before the one full schema decode (parse error aborts, exit 1)                                                       |
| `<workdir>/supabase/.env`, `.env.local`        | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml` and to collect `DOTENV_PRIVATE_KEY`(`_*`) values for decrypting `encrypted:` secrets                                                                                                                                                                                                                            |
| Auth email template HTML (`content_path`)      | HTML                      | when `auth.enabled`; paths resolved per the rules below                                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file); also re-read (its exact value compared against the resolved ref) when the resolved ref is CERTAIN to be a branch (a UUID-resolved `--project-ref`, or the target-detection probe's 404) — only once a cache candidate exists to correlate it against, to decide whether that candidate parent can be trusted |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | existence check only, to decide whether the telemetry cache write is skipped (`ensureProjectGroupsCached` — see `db/lint`'s Notes for the full mechanism); ALSO parsed (`ref`/`name`) whenever the resolved ref is CERTAIN to be a branch (a UUID-resolved `--project-ref`, or the target-detection probe's 404), to name its parent project                                  |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                                                                                                                                                    |

## Files Written

| Path                                           | Format | When                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | `Effect.ensuring` after run (success **and** failure), if ref resolved |
| `~/.supabase/telemetry.json`                   | JSON   | `Effect.ensuring` after run (success **and** failure)                  |

No writes to `config.toml`.

## API Routes

All Bearer-authenticated. Iterated in this order; a service is skipped (no GET)
when its local gate is off.

| #   | Service                  | Method | Path                                            | Success    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------ | ------ | ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -2  | branch resolution (name) | GET    | `/v1/projects/{parent_ref}/branches/{name}`     | 200        | only when `--project-ref` names a branch by name (CLI-2289); `parent_ref` from the currently linked project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -2  | branch resolution (UUID) | GET    | `/v1/branches/{id}`                             | 200        | only when `--project-ref` is a UUID (CLI-2289); needs no linked project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -1  | target detection         | GET    | `/v1/projects/{ref}`                            | 200 or 404 | CLI-2168: 200 = plain project (its `name` is shown); 404 = `ref` is a preview branch. Wrapped in a `"Checking project..."` task and bounded at 5s. Entirely best-effort/diagnostic: a TIMEOUT, a transport failure, or any OTHER status degrades to an "unknown" target (never silently "project" — that would skip the confirmation gate for a real branch — and never a hard failure that aborts an otherwise-successful push, e.g. for a scoped token that can write service config but can't read the project record). Skipped entirely when `--project-ref` already named a branch by name/UUID above. |
| -1  | branch name lookup       | GET    | `/v1/projects/{parent_ref}/branches`            | 200        | only on the 404 path above, or a UUID-resolved target (never when the probe degrades to "unknown" — that never attempts recovery) — and only when a candidate parent is known (from `--project-ref` or `.temp/linked-project.json`); best-effort, 5s-bounded — a failure only omits the branch's name/parent from the echoed message, it never fails the command                                                                                                                                                                                                                                            |
| 0   | cost matrix              | GET    | `/v1/projects/{ref}/billing/addons`             | 200        | raw HTTP; cost map for 1-variant addons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 1   | api                      | GET    | `/v1/projects/{ref}/postgrest`                  | 200        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1   | api                      | PATCH  | `/v1/projects/{ref}/postgrest`                  | 200        | only if diff present + kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2a  | db.settings              | GET    | `/v1/projects/{ref}/config/database/postgres`   | 200        | always processed (no gate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2a  | db.settings              | PUT    | `/v1/projects/{ref}/config/database/postgres`   | 200        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2b  | db.network_restrictions  | GET    | `/v1/projects/{ref}/network-restrictions`       | 200        | only if local `enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2b  | db.network_restrictions  | POST   | `/v1/projects/{ref}/network-restrictions/apply` | 201        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2c  | db.ssl_enforcement       | GET    | `/v1/projects/{ref}/ssl-enforcement`            | 200        | only if `[db.ssl_enforcement]` present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2c  | db.ssl_enforcement       | PUT    | `/v1/projects/{ref}/ssl-enforcement`            | 200        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | auth                     | GET    | `/v1/projects/{ref}/config/auth`                | 200        | only if local `auth.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | auth                     | PATCH  | `/v1/projects/{ref}/config/auth`                | 2xx        | MFA phone/webauthn gated by addon cost prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | storage                  | GET    | `/v1/projects/{ref}/config/storage`             | 200        | only if local `storage.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | storage                  | PATCH  | `/v1/projects/{ref}/config/storage`             | 2xx        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | experimental.webhooks    | POST   | `/v1/projects/{ref}/database/webhooks/enable`   | 2xx        | only if local `webhooks.enabled`; no GET/diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`UpdateSigningKeys` is **not** called by `config push`.

## Environment Variables

| Variable                                     | Purpose                                                                                                   | Required?                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`                        | project ref (flag → this → `.temp/project-ref` → prompt)                                                  | no                                                                                                                                                                                        |
| `SUPABASE_YES`                               | auto-confirm prompts (`--yes`)                                                                            | no                                                                                                                                                                                        |
| `SUPABASE_ACCESS_TOKEN`                      | auth token (bypasses credential file/keyring lookup)                                                      | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                                   |
| `SUPABASE_PROFILE`                           | API profile selection                                                                                     | no                                                                                                                                                                                        |
| `env(VAR)` references                        | interpolated into `config.toml` values at load                                                            | no                                                                                                                                                                                        |
| `DOTENV_PRIVATE_KEY`, `DOTENV_PRIVATE_KEY_*` | decrypt `encrypted:` (dotenvx) secret values before hashing/pushing; comma-split, first matching key wins | only if a `config.Secret`-typed field (see below) holds an `encrypted:` value — an `encrypted:`-looking string in a non-secret field (e.g. an email template `subject`) never needs a key |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success, **including** declining one of the per-service `keep()` confirmation prompts (`api`/`db`/`auth`/`storage`/`webhooks`/MFA addon prompts)                                                                             |
| `1`  | user declined the branch confirmation gate (cancellation, `LegacyConfigPushCancelledError`) — see Output below                                                                                                               |
| `1`  | malformed `config.toml`                                                                                                                                                                                                      |
| `1`  | an `encrypted:` (dotenvx) secret anywhere in the document cannot be decrypted (see below)                                                                                                                                    |
| `1`  | invalid `auth.email.*.content_path` (missing/unreadable template file when `auth.enabled`)                                                                                                                                   |
| `1`  | two `[remotes.*]` blocks declare the same `project_id` as the target ref                                                                                                                                                     |
| `1`  | list-addons failure (network or non-200)                                                                                                                                                                                     |
| `1`  | any per-service read/update failure (network or unexpected status)                                                                                                                                                           |
| `1`  | `--project-ref` names a branch that doesn't exist, isn't provisioned yet, or fails to resolve (network/status failure); or names a branch by name while no project is linked, or the linked parent ref is invalid (CLI-2289) |

## Output

### `--output-format text`

All diagnostics on **stderr**, no stdout. When a `[remotes.<name>]` block matches the
target ref, `Loading config override: [remotes.<name>]` prints first. Then the
target-echo block (CLI-2168) — for a plain project, `Pushing config to project: <name> (<ref>)`
(degrades to the bare `Pushing config to project: <ref>` when no name could be
resolved); for a branch, `Pushing config to branch: <name> (<ref>)` followed,
only when known, by a second line `  Parent project: <name> (<ref>)` (either
half degrades to a bare ref on its own when its name isn't known; the parent
line is omitted entirely when no parent could be determined at all) — this
line always prints for a branch target, whether or not the confirmation gate
below is shown; or, when the target-detection probe couldn't tell at all
(a timeout, a transport failure, or an unexpected status), `Pushing config
to: <ref> (could not determine whether this is a branch or the main
project)` — this shape never gates a confirmation and the push proceeds.
When the target is a branch AND it was resolved IMPLICITLY
(no explicit `--project-ref <name-or-uuid>` this invocation — e.g. a stale
`.temp/project-ref` from an old `link`, or `SUPABASE_PROJECT_ID` pointing
somewhere forgotten), a confirmation gate follows immediately —
`Do you want to push config to branch "<name>" (<ref>)? (skip this check with
--yes) [y/N] ` (bare ref, no quotes, when the name is unknown). An EXPLICIT
`--project-ref <branch-name-or-uuid>` this invocation skips the gate entirely
(same-invocation intent already expressed once) — only the target-echo line
above prints, and the push proceeds immediately.
Declining fails the command (`LegacyConfigPushCancelledError`, exit `1`) — the
rendered text is `context canceled` (`Output.fail`'s standard text-mode
rendering, no `--debug` hint) — before any further network call (not even the
cost-matrix fetch). Unlike this command's other confirmations, this gate's
default is **no**: a non-TTY run with no piped answer, or `--output-format
json`/`stream-json`, declines (and fails) rather than proceeding, unless
`--yes`/`SUPABASE_YES` is set. A plain-project target never shows this prompt.
Then per service either `Remote <X> config is up to date.` or `Updating <X>
service with config: <unified diff>`; experimental prints `Enabling webhooks
for project: <ref>`. The remaining per-service confirmations are unchanged:
`<title> [Y/n] ` (or `<title> [Y/n] y` when `--yes`) — and still exit **0** on
decline, only the branch gate above now fails.

### `--output-format json` / `stream-json`

Per-service diagnostics stay on stderr; the branch confirmation gate above
auto-**declines** (and fails) without `--yes` (see above — this gate's default
differs from every other confirmation in this command, which auto-confirm). A
structured summary is emitted on stdout via `output.success("", data)`; a
declined/failed branch gate instead emits this command's standard machine
error envelope (`{_tag: "Error", error: {...}}` in `json` mode, a `{type:
"error", ...}` NDJSON event in `stream-json` mode) with no success payload.

`json` mode — one flat object (note the empty `message` field added by
`output.success`); `is_branch`/`branch`/`parent_project_ref` are additive
(CLI-2168/CLI-2289) — `branch`/`parent_project_ref` are present only when
resolved, and `is_branch` itself is OMITTED entirely (not `false`) for the
"could not determine" target above — an absent key is the honest "unknown"
signal, since asserting `false` would be as misleading as asserting `true`:

```jsonc
{
  "project_ref": "abcdefghijklmnopqrst",
  "is_branch": false,
  "services": [{ "service": "api", "status": "updated" }],
  "message": "",
}
```

```jsonc
{
  "project_ref": "bbbbbbbbbbbbbbbbbbbb",
  "is_branch": true,
  "branch": "feat-x",
  "parent_project_ref": "pppppppppppppppppppp",
  "services": [{ "service": "api", "status": "updated" }],
  "message": "",
}
```

`stream-json` mode — an NDJSON `result` event with the payload nested under
`data` (consumers read `result.data.project_ref`, not `result.project_ref`):

```jsonc
{ "type": "result", "data": { "project_ref": "…", "is_branch": false, "services": […], "message": "" }, "timestamp": "…" }
```

`status ∈ "updated" | "up_to_date" | "skipped" | "disabled"`; dotted `service`
keys mirror `config.toml` paths. When the branch gate declines (machine
format without `--yes`), the command fails (exit `1`) with the standard error
envelope in place of the success payload — see above.

## Notes

- **`--project-ref` accepts a project ref, or the name (or UUID) of a branch of the linked project** (CLI-2289, the same vocabulary `link`/`config diff` already accept). A value that is exactly 20 lowercase letters is always treated as a ref. A name is resolved against the currently linked project (fails if none is linked, or if the linked ref is itself invalid); a UUID resolves directly and needs no linked project at all.
- **Every invocation detects whether the resolved ref is the linked project, one of its branches, or genuinely undeterminable** (CLI-2168) and always echoes which one before doing anything else — see Output below. When `--project-ref` already named a branch by name/UUID, this is known for free (certain, never re-derived from a live probe); otherwise it's a live `GET /v1/projects/{ref}` probe: 200 is a plain project, 404 confirms a branch, and EVERYTHING else (a TIMEOUT, a transport failure, or any other status) degrades to "unknown" — never "project" (that would skip the confirmation gate for what might genuinely be a branch) and never a hard failure (this probe is diagnostic-only and must never block a push that would otherwise succeed). A confirmed branch's own name/parent are recovered best-effort from `.temp/linked-project.json`/`.temp/project-ref` and a branch-list lookup. A CONFIRMED branch target resolved IMPLICITLY (not via an explicit `--project-ref <name-or-uuid>` this invocation) is gated behind a confirmation before any further network call; a target resolved from an EXPLICIT `--project-ref <name-or-uuid>` this invocation skips that confirmation (same-invocation intent already expressed once); an "unknown" target is never gated at all. The target-echo line always prints regardless of which shape it is.
- **Resolution runs BEFORE the config load**, not after: a `[remotes.<name>]` overlay is merged INSIDE `loadCliConfig` itself before its one full schema decode, and only one decode may ever run per invocation — reloading with a different `projectRef` a second time would either double the load-time deprecation warnings or wrongly reject a base document that's only valid once its matching remote's overlay applies. The accepted tradeoff: a branch name/UUID resolution's network call can fire even when the local `config.toml` turns out to be malformed (this only affects `--project-ref <name-or-uuid>`; a ref-shaped or absent target never needs a network call to resolve, so a malformed config there still aborts with zero requests made, matching this command's behavior before CLI-2168/CLI-2289).
- **A non-TTY script piping multiple `y`/`n` answers needs one extra leading answer for an IMPLICIT branch target.** The branch confirmation gate reads one piped stdin line just like any other prompt in this command; it runs before the per-service `keep()` prompts, so a script written for the pre-CLI-2168 prompt sequence (`api`, `db`, `auth`, ...) has every answer shifted by one when its target happens to be an inferred branch. A plain-project target, or a target named explicitly via `--project-ref`, is unaffected (no new prompt fires).
- The post-run linked-project telemetry cache fill (`Effect.ensuring`, unconditional) may issue its own `GET /v1/projects/{ref}` independent of the target-detection probe above — both are best-effort/non-fatal for that fill, so a branch ref 404ing there is expected and harmless.
- Run from the project root (or pass `--workdir`); `config.toml` is read relative to it.
- Auth email `content_path` resolution: `[auth.email.template.*]` and `[auth.email.notification.*]` paths are relative to the discovered project root; notification paths fall back to the legacy `supabase/`-relative location when the root-resolved file is missing. Notification HTML is read only when `enabled = true`.
- Diff bytes use the BurntSushi TOML encoder + anchored diff ports.
- Optional `*pointer` sections (`db.ssl_enforcement`, `storage.image_transformation`, `storage.s3_protocol`) are decoded as defaulted-present by `@supabase/config`; their true presence is recovered from the raw (merged) config document so they are skipped when absent.
- **`[remotes.*]` overrides are merged before push.** When a `[remotes.<name>]` block declares `project_id == <ref>`, `@supabase/config` merges that block's subtree over the base config at the raw (pre-decode) level — `mergeRemoteConfig` — so only the keys the block declares override the base. `Loading config override: [remotes.<name>]` prints to stderr. Two remotes sharing the target `project_id` abort with a `duplicate project_id for [remotes.<b>] and [remotes.<a>]` message.
- **`encrypted:` (dotenvx) secrets are decrypted, hashed, and pushed as plaintext**. `DOTENV_PRIVATE_KEY`(`_*`) values from the shell + `supabase/.env` decrypt the ciphertext; the decrypted plaintext is what gets hashed for the diff and sent as `Secret.Value` in the update body. The ciphertext itself is never pushed.
- **An undecryptable secret aborts before any network call.** Before the cost-matrix list-addons request or any other service call, every `config.Secret`-typed value in the document is asserted decryptable — not just `auth.*` (the only fields `config push` actually sends), via a document-wide decode hook that runs the same check regardless of which fields a given command reads. This covers `[db.vault]` (a `map[string]Secret`, not just an `auth.*` field). An undecryptable value aborts with a `failed to parse config: <cause>` message, exit code `1`.
- **Deprecated `[auth.external.{linkedin,slack}]` secrets are checked before they're stripped.** `@supabase/config` strips these deprecated blocks from the decoded document before returning it, but the decrypt hook runs at decode time — before validation later deletes them — so `config push` re-checks the stripped-out sub-objects separately, following the decode-before-delete order rather than missing a secret hiding in one of them.
- KNOWN GAPS:
  - The document-wide decrypt-or-abort pre-check scans the config document `@supabase/config` hands back, which has the _matched_ `[remotes.<name>]` block already merged in and its `remotes` key removed. An `encrypted:` secret that's undecryptable inside a **different, non-matching** `[remotes.*]` block is therefore not caught here. Narrow edge case: it only matters when a project declares multiple remotes and the _unused_ one has a broken secret.
