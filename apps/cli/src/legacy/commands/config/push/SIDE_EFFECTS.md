# `supabase config push`

Pushes the local `supabase/config.toml`'s declared, pushable properties to the
linked project's (or, via `--project-ref <branch-name-or-uuid>`, one of its
branches') Management API. Always reports which project/branch it resolved first
(CLI-2168), gating an implicitly-resolved branch target behind a confirmation.
Reads the project's effective configuration
once, diffs it against the local file's projection, and for each resource
(api / db.settings / db.network_restrictions / db.ssl_enforcement / auth /
storage) that has a pushable difference, prints the change and confirms
before writing — the request body carries only the changed properties, plus
any keys the target endpoint requires alongside them (see the API Routes
notes below). A property your file doesn't declare is never written.

## Files Read

| Path                                           | Format                    | When                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML                      | always, AFTER the target ref is resolved (branch/UUID resolution's own network call, when it applies, runs first — see Notes) — with the resolved ref passed in the SAME `loadCliConfig` call so a matching `[remotes.<name>]` block's overlay is merged before the one full schema decode (parse error aborts, exit 1)                                                       |
| `<workdir>/supabase/.env`, `.env.local`        | dotenv                    | always, to resolve `env(VAR)` references inside `config.toml` and to collect `DOTENV_PRIVATE_KEY`(`_*`) values for decrypting `encrypted:` secrets                                                                                                                                                                                                                            |
| Auth email template HTML (`content_path`)      | HTML                      | when `auth.enabled`; paths resolved per the rules below                                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file); also re-read (its exact value compared against the resolved ref) when the resolved ref is CERTAIN to be a branch (a UUID-resolved `--project-ref`, or the target-detection probe's 404) — only once a cache candidate exists to correlate it against, to decide whether that candidate parent can be trusted |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | existence check only, to decide whether the cache write below is skipped (`ensureProjectGroupsCached` telemetry cache — see `db/lint`'s Notes for the full mechanism); ALSO parsed (`ref`/`name`) whenever the resolved ref is CERTAIN to be a branch (a UUID-resolved `--project-ref`, or the target-detection probe's 404), to name its parent project                      |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                                                                                                                                                    |

## Files Written

| Path                                           | Format | When                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | `Effect.ensuring` after run (success **and** failure), if ref resolved |
| `~/.supabase/telemetry.json`                   | JSON   | `Effect.ensuring` after run (success **and** failure)                  |

No writes to `config.toml`.

## API Routes

All Bearer-authenticated. A write is skipped (no request at all) when its
resource has no pushable difference, when its response block was omitted
from the read, when the resource's local gate is off, or when the user
declines the confirmation prompt.

| #   | Resource                 | Method | Path                                            | Success    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------ | ------ | ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -2  | branch resolution (name) | GET    | `/v1/projects/{parent_ref}/branches/{name}`     | 200        | only when `--project-ref` names a branch by name (CLI-2289); `parent_ref` from the currently linked project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -2  | branch resolution (UUID) | GET    | `/v1/branches/{id}`                             | 200        | only when `--project-ref` is a UUID (CLI-2289); needs no linked project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -1  | target detection         | GET    | `/v1/projects/{ref}`                            | 200 or 404 | CLI-2168: 200 = plain project (its `name` is shown); 404 = `ref` is a preview branch. Wrapped in a `"Checking project..."` task and bounded at 5s. Entirely best-effort/diagnostic: a TIMEOUT, a transport failure, or any OTHER status degrades to an "unknown" target (never silently "project" — that would skip the confirmation gate for a real branch — and never a hard failure that aborts an otherwise-successful push, e.g. for a scoped token that can write service config but can't read the project record). Skipped entirely when `--project-ref` already named a branch by name/UUID above. |
| -1  | branch name lookup       | GET    | `/v1/projects/{parent_ref}/branches`            | 200        | only on the 404 path above, or a UUID-resolved target (never when the probe degrades to "unknown" — that never attempts recovery) — and only when a candidate parent is known (from `--project-ref` or `.temp/linked-project.json`); best-effort, 5s-bounded — a failure only omits the branch's name/parent from the echoed message, it never fails the command                                                                                                                                                                                                                                            |
| 0   | cost matrix              | GET    | `/v1/projects/{ref}/billing/addons`             | 200        | raw HTTP; cost map for 1-variant addons; unchanged, still fetched first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 1   | effective project config | GET    | `/v2/projects/{ref}/config`                     | 200        | the ONLY read this command makes — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | api                      | PATCH  | `/v1/projects/{ref}/postgrest`                  | 200        | only when `api` has a pushable change, its response block was returned, and the change is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | db.settings              | PUT    | `/v1/projects/{ref}/config/database/postgres`   | 200        | same conditions (this resource's own local gate is "always on")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | db.network_restrictions  | POST   | `/v1/projects/{ref}/network-restrictions/apply` | 201        | same conditions, plus `db.network_restrictions.enabled` locally; body always carries both CIDR arrays together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | db.ssl_enforcement       | PUT    | `/v1/projects/{ref}/ssl-enforcement`            | 200        | same conditions, plus `[db.ssl_enforcement]` declared locally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | auth                     | PATCH  | `/v1/projects/{ref}/config/auth`                | 2xx        | same conditions, plus `auth.enabled` locally; MFA phone/webauthn gated by an addon cost prompt when `verify_enabled` or `enroll_enabled` is being turned on and the add-on is not already active on the project                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | storage                  | PATCH  | `/v1/projects/{ref}/config/storage`             | 2xx        | same conditions, plus `storage.enabled` locally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | experimental.webhooks    | POST   | `/v1/projects/{ref}/database/webhooks/enable`   | 2xx        | only if local `webhooks.enabled`; no GET/diff; a kept enable reports `changes: [["experimental","webhooks","enabled"]]` (no config-diff path backs it) so it still counts toward the pushed-property total                                                                                                                                                                                                                                                                                                                                                                                                  |

**Row 1 is the only per-resource `GET` this command makes** — no per-service
`GET /v1/…` request remains anywhere in this table; row 1's single response
is every resource's entire source of remote state. Rows -2/-1 are a
DIFFERENT concern (resolving and describing WHAT `ref` is, before any
resource is even considered) and run at most once per invocation, never
per-resource. `UpdateSigningKeys` is **not**
called by `config push`. No spinner on the read; 401/403/404 get
purpose-written messages, every other status the generic
`unexpected status N: body` shape. The read's response is echoed via a
`Comparison scope:` line every run (not just when a block is missing — family
consistency with `config diff`/`config pull`); a resource whose own block was
omitted from the response is reported as `unavailable` and is never written
to, since there is nothing to safely compare against. If the response
carries **no block at all**, the command aborts before touching any resource
(`LegacyConfigPushConfigEmptyError`, exit 1, zero writes) rather than risk
treating every declared property as a fresh write with no remote value to
compare against.

Each write's body is sparse: only the properties that changed ship, except
for a handful of groups the target endpoint requires together even when only
one member changed — the network-restriction CIDR pair, each storage feature
container (`image_transformation`, `s3_protocol`, `analytics`, `vector`), the
SMTP key set (or just `smtp_host: ""` to disable it), captcha, each auth
hook, each OAuth provider, and the currently-active SMS provider. An
undeclared member of one of these groups is sent with the project's CURRENT
value — read from the same row-1 response, so it does not change — never a
value your file doesn't declare. Only when that response did not report a
member's current value at all does it fall back to a local/schema-default
value, and that fallback is always disclosed as a `[group-write]` block in
the confirmation output and as a `forced` entry in the JSON payload (see
Output below) — never applied silently. A property outside one of these
groups that your file doesn't declare never appears in any write, even when
the group it belongs to ships for another reason.

Some declared properties have no Management API field at all and are only
reported, never pushed: `db.major_version` and
`db.pooler.{pool_mode,default_pool_size,max_client_conn}` — reported in the
"no Management API field" `Note:` line. `auth.oauth_server.*` is NOT in that
list, even though it also has no v1 write path: `@supabase/config`'s local
projection drops the whole `auth.oauth_server` subtree unconditionally (no
push encoder handles it at all), so a declared value there never reaches
`changeSet.changes` in the first place — it is reported
today as `unmanaged` instead (below), the same as any other property the
projection drops. `push.plan.ts` still carries `auth.oauth_server` in its own
unsupported-prefix list so that a declared value there is classified
correctly the moment CLI-2314 stops pruning it from the projection; until
then that list entry is a defensive no-op. A resource whose local gate is
off (e.g. a declared `auth.*` value while `auth.enabled = false`) is NOT
reported in the "no Management API field" note either: the projection's
disabled-sentinel prune already removes its other declared keys before
diffing, so it stays silently `disabled` in text mode (reported as
`disabled` in the JSON payload's `services[]` entry — see Output below).
Separately, a handful of declared, gated-on values can't be structurally
expressed by their encoder — `api.enabled = true` with no `api.schemas`
declared, no SMS provider locally enabled while an SMS-family value changed,
an invalid `auth.*` duration string (`sessions.timebox`,
`mfa.phone.max_frequency`, `email.max_frequency`, `sms.max_frequency`), or
one network-restriction CIDR array declared while its companion array
cannot be resolved from either the read or the file — reported in their own
`Note:` line with the specific reason. See Output below for both.

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
| `1`  | `--project-ref` names a branch that doesn't exist, isn't provisioned yet, or fails to resolve (network/status failure); or names a branch by name while no project is linked, or the linked parent ref is invalid (CLI-2289) |
| `1`  | malformed `config.toml`                                                                                                                                                                                                      |
| `1`  | an `encrypted:` (dotenvx) secret anywhere in the document cannot be decrypted (see below)                                                                                                                                    |
| `1`  | invalid `auth.email.*.content_path` (missing/unreadable template file when `auth.enabled`)                                                                                                                                   |
| `1`  | two `[remotes.*]` blocks declare the same `project_id` as the target ref                                                                                                                                                     |
| `1`  | list-addons failure (network or non-200)                                                                                                                                                                                     |
| `1`  | effective-project-config read failure (network, decode, or unexpected status) — one failure mode now covers what used to be six independent per-service read failures                                                        |
| `1`  | the API's effective project configuration fails to parse                                                                                                                                                                     |
| `1`  | the effective-project-config response carried no block at all (`LegacyConfigPushConfigEmptyError`) — nothing was pushed                                                                                                      |
| `1`  | any per-service update failure or webhook-enable failure (network or unexpected status)                                                                                                                                      |

## Output

### `--output-format text`

All diagnostics on **stderr**, no stdout. When a `[remotes.<name>]` block matches the
target ref, `Loading config override: [remotes.<name>]` prints first. Then the
target-echo block (CLI-2168) — for a plain project, `Pushing config to project: <name>
(<ref>)` (degrades to the bare `Pushing config to project: <ref>` when no name could be
resolved); for a branch, `Pushing config to branch: <name> (<ref>)` followed, only when
known, by a second line `  Parent project: <name> (<ref>)` (either half degrades to a
bare ref on its own when its name isn't known; the parent line is omitted entirely when
no parent could be determined at all) — this line always prints for a branch target,
whether or not the confirmation gate below is shown; or, when the target-detection probe
couldn't tell at all (a timeout, a transport failure, or an unexpected status), `Pushing
config to: <ref> (could not determine whether this is a branch or the main project)` —
this shape never gates a confirmation and the push proceeds. When the target is a
branch AND it was resolved IMPLICITLY (no explicit `--project-ref <name-or-uuid>` this
invocation — e.g. a stale `.temp/project-ref` from an old `link`, or
`SUPABASE_PROJECT_ID` pointing somewhere forgotten), a confirmation gate follows
immediately — `Do you want to push config to branch "<name>" (<ref>)? (skip this check
with --yes) [y/N] ` (bare ref, no quotes, when the name is unknown). An EXPLICIT
`--project-ref <branch-name-or-uuid>` this invocation skips the gate entirely
(same-invocation intent already expressed once) — only the target-echo line above
prints, and the push proceeds immediately. Declining fails the command
(`LegacyConfigPushCancelledError`, exit `1`) — the rendered text is `context canceled`
(`Output.fail`'s standard text-mode rendering, no `--debug` hint) — before any further
network call (not even the cost-matrix fetch). Unlike this command's other
confirmations, this gate's default is **no**: a non-TTY run with no piped answer, or
`--output-format json`/`stream-json`, declines (and fails) rather than proceeding,
unless `--yes`/`SUPABASE_YES` is set. A plain-project target never shows this prompt.
Then `Comparison scope: <present> (not returned:
<missing>)` — printed EVERY run, not just when a block is missing (family consistency
with `config diff`/`config pull`). Then, per resource, one of:

- `Remote <X> config is up to date.` — no pushable difference existed.
- `Remote <X> config has N difference(s) config push cannot write (see notes below).` —
  a pushable difference existed, but every one of it was unencodable; nothing written.
- nothing (silently skipped) — the resource's own response block was omitted from the
  read (`unavailable`), or its local gate is off (`disabled`).
- the confirmation block:

```
Updating <X> service with config:
<path> [update]
  local:  <value>
  remote: <value>

<path> [secret]
  local:  (set)
  remote: (set — differs)

<path> [content]
  local:  (file content from content_path)
  remote: (differs)

<path> [group-write]
  local:  <value> (schema default — not declared in config.toml)
  remote: (not returned)

```

— one `[update]` block per changed declared property, in the same per-property format
`supabase config diff` prints; a changed secret renders `[secret]` with no value, just
whether the remote digest was present or absent (a secret that will NOT be sent because
it's empty or an unresolved `env(...)` reference discloses that here too, before the
prompt); `[content]` is a mailer template/notification body with no config path of its
own; `[group-write]` is an undeclared companion the endpoint required alongside a
declared change, sent at its schema default because the read didn't report the
project's current value for it. Secret values never appear in output. Every block ends
on a blank line. Experimental prints `Enabling webhooks for project: <ref>`. The
per-service confirmations are unchanged from before CLI-2168: they render
`<title> [Y/n] ` (or `<title> [Y/n] y` when `--yes`) and still exit **0** on decline —
only the branch confirmation gate described above fails.

After the resource loop, up to six `Note:` lines report anything the push couldn't do
or had to work around:

```
Note: 2 declared properties have no Management API field and were not pushed: db.major_version, db.pooler.pool_mode (change them from the dashboard).
Note: 1 declared property could not be encoded and was not pushed: api.enabled (enabling the Data API needs at least one schema in api.schemas)
Note: 1 declared property is not managed by config push and was not compared; run `supabase config diff` to list them.
Note: 1 undeclared property had to be sent alongside a declared change and was written at its config default: db.network_restrictions.allowed_cidrs_v6 (the values shown in the confirmation block were applied).
Note: 1 credential value was not pushed (empty or unresolved env reference): auth.captcha.secret
Note: 12 remote properties are not declared in supabase/config.toml and were left unchanged (config push no longer resets undeclared properties to their defaults; run `supabase config diff` to inspect).
```

Each line is omitted when its count is `0`; the leading count pluralizes the noun that
follows it. The third line (unmanaged) is COUNT ONLY — no path list — and excludes any
path that belongs to a resource whose local gate is already off (reported instead by
that resource's own silent `disabled` status). Every interpolated path/name goes
through the same control-character sanitizing `config diff` uses.

### `--output-format json` / `stream-json`

Per-service diagnostics stay on stderr; the per-service `keep()` prompts auto-confirm
(default yes) — but the branch confirmation gate above (CLI-2168) auto-**declines** (and
fails) without `--yes`, since its default differs from every other confirmation in this
command. A structured summary is emitted on stdout via `output.success(message, data)`;
a declined/failed branch gate instead emits this command's standard machine error
envelope (`{_tag: "Error", error: {...}}` in `json` mode, a `{type: "error", ...}` NDJSON
event in `stream-json` mode) with no success payload.

`json` mode — one flat object (`message` is a one-sentence summary, with a
caveat sentence appended for anything withheld — see below); `is_branch`/`branch`/
`parent_project_ref` are additive (CLI-2168/CLI-2289) — `branch`/`parent_project_ref` are
present only when resolved, and `is_branch` itself is OMITTED entirely (not `false`) for
the "could not determine" target — an absent key is the honest "unknown" signal, since
asserting `false` would be as misleading as asserting `true`:

```jsonc
{
  "schema_version": 1,
  "project_ref": "abcdefghijklmnopqrst",
  "is_branch": false,
  "services": [{ "service": "api", "status": "updated", "changes": [["api", "max_rows"]] }],
  "unsupported": [["db", "pooler", "pool_mode"]],
  "unencodable": [
    {
      "path": ["api", "enabled"],
      "reason": "enabling the Data API needs at least one schema in api.schemas",
    },
  ],
  "forced": [{ "path": ["db", "network_restrictions", "allowed_cidrs_v6"], "value": [] }],
  "unmanaged": [["auth", "oauth_server", "enabled"]],
  "secrets": {
    "sent": [["auth", "captcha", "secret"]],
    "unchanged": [],
    "not_set": [],
    "gated": [],
    "unencodable": [],
    "skipped": [],
  },
  "declined_addons": [],
  "remote_only": 12,
  "scope": {
    "present": ["api", "auth", "database", "pooler", "realtime", "storage"],
    "missing": [],
  },
  "message": "1 property pushed to abcdefghijklmnopqrst. 2 declared properties could not be pushed. 1 declared property is not managed by config push.",
}
```

A branch target additionally carries `branch`/`parent_project_ref` when they resolved:

```jsonc
{
  "project_ref": "bbbbbbbbbbbbbbbbbbbb",
  "is_branch": true,
  "branch": "feat-x",
  "parent_project_ref": "pppppppppppppppppppp",
  "services": [{ "service": "api", "status": "updated" }],
  "message": "1 property pushed to bbbbbbbbbbbbbbbbbbbb.",
}
```

`message`'s base sentence is `N property/properties pushed to <ref>.` when at
least one service updated (`N` is the total size of every `updated`
service's `changes`), `Nothing to push: the project already matches the
declared properties.` when every service is `up_to_date`/`disabled`, or
`Nothing was pushed.` otherwise. A caveat sentence is appended, in this
fixed order, for each non-empty category: unsupported+unencodable, unmanaged,
`scope.missing`, skipped services, not-set credentials, declined add-on
prompts — so an agent echoing just `.message` never reports success while
something declared was withheld. The `scope.missing` caveat counts only the
blocks this command actually reads from (`api`, `database`, `auth`,
`storage`); an omitted `pooler`/`realtime` block — which `config push` never
compares against — never triggers it, even though the `Comparison scope:`
line above always lists every missing block.

`stream-json` mode — an NDJSON `result` event with the payload nested under
`data` (consumers read `result.data.project_ref`, not `result.project_ref`):

```jsonc
{ "type": "result", "data": { "project_ref": "…", "is_branch": false, "services": […], "message": "1 property pushed to abcdefghijklmnopqrst." }, "timestamp": "…" }
```

`status ∈ "updated" | "up_to_date" | "skipped" | "disabled" | "unavailable" |
"not_pushable"` — `unavailable` means the read omitted this resource's block (nothing
compared, nothing written); `not_pushable` means a pushable difference existed but none
of it was encodable. `services[].service` is an OPAQUE IDENTIFIER (a dotted key
mirroring — but not equal to — a `config.toml` path, plus the fixed string
`"experimental.webhooks"`), never itself a config path to be parsed or compared.
`project_ref`, `services[].service`, and `services[].status` are the established
contract; every other field is additive. When the branch gate declines (machine format
without `--yes`), the command fails (exit `1`) with the standard error envelope in place
of the success payload — see above. `secrets` partitions every declared secret
(`changeSet.masked`) across its six buckets, reporting what was OBSERVED to happen —
`sent` only when the auth write actually ran AND the container carrying that secret
placed it in the request body. A `send`-decided secret whose write did not run
(declined prompt, or auth not written for any other reason) lands in `skipped`
instead; a `send`-decided secret whose container was dropped as `unencodable` (its
required-together group unresolvable, even while OTHER auth fields still triggered a
write) lands in neither `sent` nor `skipped` — it is reported in `unencodable` instead,
so it is never silently swallowed. `declined_addons` lists which paid MFA addon prompts
(`auth_mfa_phone`,
`auth_mfa_web_authn`) were declined this run. Paths are segment arrays — a record key
may itself contain a `.`.

## Notes

- **`--project-ref` accepts a project ref, or the name (or UUID) of a branch of the linked project** (CLI-2289, the same vocabulary `link`/`config diff` already accept). A value that is exactly 20 lowercase letters is always treated as a ref. A name is resolved against the currently linked project (fails if none is linked, or if the linked ref is itself invalid); a UUID resolves directly and needs no linked project at all.
- **Every invocation detects whether the resolved ref is the linked project, one of its branches, or genuinely undeterminable** (CLI-2168) and always echoes which one before doing anything else — see Output above. When `--project-ref` already named a branch by name/UUID, this is known for free (certain, never re-derived from a live probe); otherwise it's a live `GET /v1/projects/{ref}` probe: 200 is a plain project, 404 confirms a branch, and EVERYTHING else (a TIMEOUT, a transport failure, or any other status) degrades to "unknown" — never "project" (that would skip the confirmation gate for what might genuinely be a branch) and never a hard failure (this probe is diagnostic-only and must never block a push that would otherwise succeed). A confirmed branch's own name/parent are recovered best-effort from `.temp/linked-project.json`/`.temp/project-ref` and a branch-list lookup. A CONFIRMED branch target resolved IMPLICITLY (not via an explicit `--project-ref <name-or-uuid>` this invocation) is gated behind a confirmation before any further network call; a target resolved from an EXPLICIT `--project-ref <name-or-uuid>` this invocation skips that confirmation (same-invocation intent already expressed once); an "unknown" target is never gated at all. The target-echo line always prints regardless of which shape it is.
- **Resolution runs BEFORE the config load**, not after: a `[remotes.<name>]` overlay is merged INSIDE `loadCliConfig` itself before its one full schema decode, and only one decode may ever run per invocation — reloading with a different `projectRef` a second time would either double the load-time deprecation warnings or wrongly reject a base document that's only valid once its matching remote's overlay applies. The accepted tradeoff: a branch name/UUID resolution's network call can fire even when the local `config.toml` turns out to be malformed (this only affects `--project-ref <name-or-uuid>`; a ref-shaped or absent target never needs a network call to resolve, so a malformed config there still aborts with zero requests made, matching this command's behavior before CLI-2168/CLI-2289).
- **A non-TTY script piping multiple `y`/`n` answers needs one extra leading answer for an IMPLICIT branch target.** The branch confirmation gate reads one piped stdin line just like any other prompt in this command; it runs before the per-service `keep()` prompts, so a script written for the pre-CLI-2168 prompt sequence (`api`, `db`, `auth`, ...) has every answer shifted by one when its target happens to be an inferred branch. A plain-project target, or a target named explicitly via `--project-ref`, is unaffected (no new prompt fires).
- The post-run linked-project telemetry cache fill (`Effect.ensuring`, unconditional) may issue its own `GET /v1/projects/{ref}` independent of the target-detection probe above — both are best-effort/non-fatal for that fill, so a branch ref 404ing there is expected and harmless.
- Run from the project root (or pass `--workdir`); `config.toml` is read relative to it.
- Auth email `content_path` resolution: `[auth.email.template.*]` and `[auth.email.notification.*]` paths are relative to the discovered project root; notification paths fall back to the legacy `supabase/`-relative location when the root-resolved file is missing. Notification HTML is read only when `enabled = true`.
- **Only properties your file declares, and whose value differs from the project, are written.** Fields the API requires together ship as a group; undeclared members of that group are sent with the project's CURRENT value, read in the same run — so they do not change. Only when the read did not return a member's current value is it sent at the config schema default, and that is always disclosed (a `[group-write]` block in the confirmation output, a `forced` entry in the JSON payload, and a summary `Note:` line) — never applied silently.
- **`db.ssl_enforcement`'s presence, not its decoded default, decides the gate.** `@supabase/config`'s projection recovers whether `[db.ssl_enforcement]` (and `storage.image_transformation`/`storage.s3_protocol`) were actually declared, as opposed to decoding to a schema default; an undeclared `[db.ssl_enforcement]` is treated as `disabled` — no read is needed for this any more, since row 1's single response already carries the remote value.
- Optional `*pointer` sections (`db.ssl_enforcement`, `storage.image_transformation`, `storage.s3_protocol`) follow that same presence rule end to end — declared-but-absent is never confused with explicitly-disabled.
- **`[remotes.*]` overrides are merged before push.** When a `[remotes.<name>]` block declares `project_id == <ref>`, `@supabase/config` merges that block's subtree over the base config at the raw (pre-decode) level — `mergeRemoteConfig` — so only the keys the block declares override the base. `Loading config override: [remotes.<name>]` prints to stderr. Two remotes sharing the target `project_id` abort with a `duplicate project_id for [remotes.<b>] and [remotes.<a>]` message.
- **`encrypted:` (dotenvx) secrets are decrypted, digested, and compared before being sent.** `DOTENV_PRIVATE_KEY`(`_*`) values from the shell + `supabase/.env` decrypt the ciphertext; the decrypted plaintext is hashed the same way the platform hashes its own stored value and compared against the digest the effective-configuration read returns for that field. A matching digest is left alone — never resent; a differing, `null`, or absent digest gets the decrypted plaintext sent in the update body. An empty value or an unresolved `env(VAR)` reference is never sent, and is reported by the credential `Note:` line instead. The ciphertext itself is never pushed, and no plaintext or digest value ever appears in CLI output.
- **A secret is only compared/sent while its parent container is present and not explicitly disabled** (e.g. a disabled `[auth.hook.custom_access_token]` never sends its `secrets` value, an absent `[auth.captcha]` never sends `security_captcha_secret`) — one uniform gate covering every secret family, in place of the previous version's five hand-coded per-secret gates.
- **An undecryptable secret aborts before any network call.** Before the cost-matrix list-addons request or any other service call, every `config.Secret`-typed value in the document is asserted decryptable — not just `auth.*` (the only fields `config push` actually sends), via a document-wide decode hook that runs the same check regardless of which fields a given command reads. This covers `[db.vault]` (a `map[string]Secret`, not just an `auth.*` field). An undecryptable value aborts with a `failed to parse config: <cause>` message, exit code `1`.
- **Deprecated `[auth.external.{linkedin,slack}]` secrets are checked before they're stripped.** `@supabase/config` strips these deprecated blocks from the decoded document before returning it, but the decrypt hook runs at decode time — before validation later deletes them — so `config push` re-checks the stripped-out sub-objects separately, following the decode-before-delete order rather than missing a secret hiding in one of them.
- KNOWN GAPS:
  - The document-wide decrypt-or-abort pre-check scans the config document `@supabase/config` hands back, which has the _matched_ `[remotes.<name>]` block already merged in and its `remotes` key removed. An `encrypted:` secret that's undecryptable inside a **different, non-matching** `[remotes.*]` block is therefore not caught here. Narrow edge case: it only matters when a project declares multiple remotes and the _unused_ one has a broken secret.
