# `supabase db dump`

Native TypeScript port (`dump.handler.ts`). Streams a `pg_dump`/`pg_dumpall`
script run inside the compose Postgres image, or catalog `pg_dump` /
`pg_dumpall` on the stack backend (native artifact or a one-shot of the same
image), to stdout or `--file`.

## Files Read

| Path                              | Format     | When                                                                                                                                         |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`            | TOML       | always (db port/password/major_version, project_id)                                                                                          |
| `supabase/.temp/postgres-version` | plain text | always (best-effort) — pins the pg image tag when present                                                                                    |
| `supabase/.temp/pooler-url`       | plain text | `--linked` when the direct host is unreachable (pooler URL)                                                                                  |
| `~/.supabase/access-token`        | plain text | `--linked` when `SUPABASE_ACCESS_TOKEN` unset                                                                                                |
| `supabase/.temp/project-ref`      | plain text | `--linked` (and the default target) ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`/config.toml `project_id`) is set |
| `supabase/.env*`                  | dotenv     | always (project env, feeds `SUPABASE_DB_PASSWORD` / `PG*`)                                                                                   |

## Files Written

| Path                            | Format | When                                                                               |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `<path>` (from `--file` / `-f`) | SQL    | when `--file` is set and **not** `--dry-run` (created/truncated `0644` before run) |

## API Routes

| Method | Path                                       | Auth   | When                                                         |
| ------ | ------------------------------------------ | ------ | ------------------------------------------------------------ |
| POST   | `/v1/projects/{ref}/cli/login-role`        | Bearer | `--linked` with no `DB_PASSWORD` (mint a temp postgres role) |
| POST   | `/v1/projects/{ref}/network-bans/retrieve` | Bearer | `--linked` pooler temp-role retry (list bans)                |
| DELETE | `/v1/projects/{ref}/network-bans`          | Bearer | `--linked` pooler temp-role retry (clear self ban)           |

(All via the shared `DbConfigResolver` `--linked` path.)

## Environment Variables

| Variable                                                                      | Purpose                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_PASSWORD` (`DB_PASSWORD` viper key; `--password`/`-p` overrides) | remote DB password                                                                                                                                                                                                                                               |
| `SUPABASE_ACCESS_TOKEN`                                                       | `--linked` auth                                                                                                                                                                                                                                                  |
| `SUPABASE_DB_ORIOLEDB_VERSION`                                                | overrides `db.orioledb_version`, selecting the OrioleDB `pg_dump` image                                                                                                                                                                                          |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION`                                      | deprecated alias of `SUPABASE_DB_ORIOLEDB_VERSION`, used only while that is unset; when set, stderr gets `WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.`                       |
| `BITBUCKET_CLONE_DIR`                                                         | (no-op for dump — no `--security-opt` is set)                                                                                                                                                                                                                    |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                            | rewrite the pg image registry for compose dumps; stack dumps use the catalog image pin unchanged                                                                                                                                                                 |
| `SUPABASE_USE_SLIM_IMAGES`                                                    | resolve the current Postgres pin from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, and flag-off `15.8.1.085` stay on docker.io |
| `DOCKER_HOST`                                                                 | docker daemon endpoint                                                                                                                                                                                                                                           |
| `MSYSTEM`, `TERM_PROGRAM`                                                     | suppress the piped-stdout non-ASCII warning in MSYS/mintty sessions                                                                                                                                                                                              |
| `SUPABASE_TARGET`                                                             | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml`                                                                                                                                         |

## Target selection

With no `--local`, `--linked` or `--db-url` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then `supabase/.env*`), then `target` in `supabase/config.toml` (or
`config.json`). `remote` targets the linked project through the existing linked path; `local`
targets the local database. An explicit selector flag always wins over the target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid
`SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config is only read for
the target when no selector flag is given; an unreadable config counts as unset.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, the `.env*` file that set it (for example `supabase/.env.local` or `.env`), `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

When neither is set the command keeps targeting the linked project and writes one warning to
**stderr** (every `--output-format`, never stdout), so scripts depending on today's default keep
working while the next major version moves it to the local database:

```
Warning: supabase db dump will target the local database by default in the next major version. Pass --linked to keep targeting the linked project. Setting target = "remote" in your Supabase config (or SUPABASE_TARGET=remote) also works, but applies to every database command that can run locally, including db reset.
```

No warning is written when a selector flag, `--project-ref`, `SUPABASE_TARGET` or `target` is set.

With a `local` workspace target and no selector flag, `--password` fails with the command's password-flag error
instead of being silently dropped; pass `--linked` or set `target = "remote"`.

## Exit Codes

| Code | Condition                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                               |
| `1`  | `--use-copy`/`--exclude` without `--data-only`; mutually-exclusive flags; bad `--file` path; connection failure; container or bundled `pg_dump`/`pg_dumpall` exit ≠ 0 |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes / Divergences)                                                                                |

## Output

SQL goes to **stdout** (or `--file`) in **all** `--output-format` modes — there is
no machine envelope for `db dump` (same rationale as `test db`). Diagnostics go
to **stderr**: `Dumping {schemas|data| roles} from {local|remote} database...`,
the `--dry-run` notice, and the `Dumped schema to <abs>.` confirmation when
`--file` is used. `--dry-run` prints the env-expanded script to stdout without
running a container; with `--file` it still prints the `Dumped schema to <abs>.`
confirmation on a successful dry-run but does **not** create or truncate the file.

On a linked dump whose container fails with an IPv6 connectivity error (no IPv4
pooler retry available, or the retry also fails), the error is followed on stderr by
the IPv4 transaction-pooler suggestion.

On Windows only, a **successful** stdout dump (no `--file`) whose stdout is a
**pipe** (PowerShell interposes one for `>`/`|`; MSYS/mintty sessions excluded
via `MSYSTEM`/`TERM_PROGRAM`) and whose bytes contain non-ASCII is followed by a
stderr warning pointing at `--file` — PowerShell 5.1 re-encodes piped native
stdout with the legacy console code page (issue #6397), which the CLI cannot
prevent. The gate is a best-effort heuristic: a pipe to a byte-faithful reader
(e.g. cmd.exe `a | b`) still warns, and a PowerShell launched from an MSYS
shell inherits the suppressing variables and is missed.

> **Credential warning:** `--dry-run` expands the pg_dump script with live env
> values, so the resolved `PGPASSWORD` (for a remote/linked project, the database
> password) is printed **in cleartext** to stdout. Operators piping `--dry-run`
> output to logs or CI artifacts should treat that output as a secret.

## Notes / Divergences

- `--data-only` XOR `--role-only`; `--keep-comments` XOR `--data-only`;
  `--schema` XOR `--role-only`; `--db-url` XOR `--linked` XOR `--local`.
  `--use-copy` / `--exclude` require `--data-only`. `--linked` defaults to true.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution used for the connection and
  the linked-project cache (flag > `SUPABASE_PROJECT_ID`/config.toml
  `project_id` > `.temp/project-ref`) — it does not affect any local container
  id. It never implies `--linked`: passing it with a resolved
  `--local`/`--db-url` target is a hard error rather than a silently discarded
  flag (deliberately stricter than `SUPABASE_PROJECT_ID`, which Go's equivalent
  env var simply leaves unused on a non-linked target).
- **Container-level pooler fallback.** When a linked dump reaches the direct host
  from the host process but the `pg_dump` container fails over IPv6, the captured
  container stderr is classified (`isIPv6ConnectivityError`) and the dump is
  retried once through the project's IPv4 transaction pooler
  (`resolver.resolvePoolerFallback`). This is in addition to the resolver's
  connect-time pooler fallback for an unreachable direct host.
  - Remaining limitation: on the no-fallback / failed-retry path, the IPv6
    suggestion uses the generic `ipv6Suggestion()` text rather than one that
    prefills the project's specific pooler connection string. Surfacing that
    exact URL needs the pooler string exposed at this seam.
- **Stack backend host rewrite.** Stack dumps always use catalog `pg_dump` (native
  artifact or a one-shot of the same image). `--local` native rewrites loopback to
  `127.0.0.1`. Native `--linked` / `--db-url` keep
  the resolved host. Managed `--local` dumps run through the stack's own command runtime
  against its endpoint without a rewrite. Other container dumps rewrite any loopback host
  (whatever its port) to `host.docker.internal` unless the tool container shares the Linux
  host network, and always run on the host network unless `--network-id` is set. Legacy
  container dumps rewrite loopback only when `--network-id` / `SUPABASE_NETWORK_ID` puts
  pg_dump on a named network. Engine/runtime selection still uses `connType`.
