# `supabase db dump`

Target: selectable, no consent — see [Command target](../../../../docs/command-target.md)

Implemented in `dump.handler.ts`. Streams a `pg_dump`/`pg_dumpall`
script run inside the compose Postgres image, or catalog `pg_dump` /
`pg_dumpall` on the stack backend (native artifact or a one-shot of the same
image), to stdout or `--file`.

## Files Read

| Path                                    | Format      | When                                                                                                                                                                   |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.json` or `config.toml` | JSON / TOML | always, `config.json` preferred (db port/password/major_version, project_id)                                                                                           |
| `supabase/.temp/postgres-version`       | plain text  | always (best-effort) — pins the pg image tag when present                                                                                                              |
| `supabase/.temp/pooler-url`             | plain text  | a remote project or branch when the direct host is unreachable (pooler URL)                                                                                            |
| `~/.supabase/access-token`              | plain text  | a remote project or branch when `SUPABASE_ACCESS_TOKEN` unset                                                                                                          |
| `supabase/.temp/project-ref`            | plain text  | bare `--remote` — ref resolution, skipped when `SUPABASE_PROJECT_ID`/config.toml `project_id` is set; with no selector, only to name the project in the `Target:` hint |
| `supabase/.env*`                        | dotenv      | always (project env, feeds `SUPABASE_DB_PASSWORD` / `PG*`; shell values win)                                                                                           |

## Files Written

| Path                            | Format | When                                                                               |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `<path>` (from `--file` / `-f`) | SQL    | when `--file` is set and **not** `--dry-run` (created/truncated `0644` before run) |

## API Routes

| Method | Path                                       | Auth   | When                                                                                                                                                                              |
| ------ | ------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role`        | Bearer | remote target with no `DB_PASSWORD` (mint a temp postgres role)                                                                                                                   |
| POST   | `/v1/projects/{ref}/network-bans/retrieve` | Bearer | remote pooler temp-role retry (list bans)                                                                                                                                         |
| DELETE | `/v1/projects/{ref}/network-bans`          | Bearer | remote pooler temp-role retry (clear self ban)                                                                                                                                    |
| GET    | `/v1/projects/{parent}/branches`           | Bearer | Branch lookup — only for `--remote=<branch>`, and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET    | `/v1/branches/{id}`                        | Bearer | Branch lookup — only for `--remote=<branch UUID>` when no project is linked                                                                                                       |

(The login-role and network-ban calls go through the shared `DbConfigResolver` linked path.)

## Environment Variables

| Variable                                             | Purpose                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_PASSWORD` (`--password`/`-p` overrides) | remote DB password; ignored for a target other than the linked project (see Notes)                                                                                                                                                                               |
| `SUPABASE_ACCESS_TOKEN`                              | auth for a remote project or branch                                                                                                                                                                                                                              |
| `SUPABASE_PROJECT_ID`                                | linked project ref override and the parent that `--remote=<branch>` is resolved against (superseded by `--remote=<ref>`)                                                                                                                                         |
| `BITBUCKET_CLONE_DIR`                                | (no-op for dump — no `--security-opt` is set)                                                                                                                                                                                                                    |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                   | rewrite the pg image registry for compose dumps; stack dumps use the catalog image pin unchanged                                                                                                                                                                 |
| `SUPABASE_USE_SLIM_IMAGES`                           | resolve the current Postgres pin from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, and flag-off `15.8.1.085` stay on docker.io |
| `DOCKER_HOST`                                        | docker daemon endpoint                                                                                                                                                                                                                                           |
| `MSYSTEM`, `TERM_PROGRAM`                            | suppress the piped-stdout non-ASCII warning in MSYS/mintty sessions                                                                                                                                                                                              |

## Exit Codes

| Code | Condition                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                               |
| `1`  | `--use-copy`/`--exclude` without `--data-only`; mutually-exclusive flags; bad `--file` path; connection failure; container or bundled `pg_dump`/`pg_dumpall` exit ≠ 0 |

## Output

SQL goes to **stdout** (or `--file`) in **all** `--output-format` modes — there is
no machine envelope for `db dump` (same rationale as `test db`). Diagnostics go
to **stderr**: alias deprecation warnings, the `Target:` line,
`Dumping {schemas|data| roles} from {local|remote} database...`,
the `--dry-run` notice, and the `Dumped schema to <abs>.` confirmation when
`--file` is used. `--dry-run` prints the env-expanded script to stdout without
running a container; with `--file` it still prints the `Dumped schema to <abs>.`
confirmation on a successful dry-run but does **not** create or truncate the file.

On a remote dump whose container fails with an IPv6 connectivity error (no IPv4
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

## Notes

- **Config value precedence** (ADR 0032): explicit flag > shell env > project `.env*` > config
  (`config.json` over `config.toml`; a matched `[remotes.*]` block over the base document on
  a remote project or branch) > default. The linked-database password env is withheld when the target differs
  from `.temp/project-ref`: stderr gets `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.` and a temporary login role is minted.
- `--data-only` XOR `--role-only`; `--keep-comments` XOR `--data-only`;
  `--schema` XOR `--role-only`. `--use-copy` / `--exclude` require `--data-only`.
- **Container-level pooler fallback.** When a remote dump reaches the direct host
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
  artifact or a one-shot of the same image). A native local dump rewrites loopback to
  `127.0.0.1`; a native remote or `--remote=<url>` dump keeps
  the resolved host. Managed local dumps run through the stack's own command runtime
  against its endpoint without a rewrite. Other container dumps rewrite any loopback host
  (whatever its port) to `host.docker.internal` unless the tool container shares the Linux
  host network, and always run on the host network unless `--network-id` is set. Legacy
  container dumps rewrite loopback only when `--network-id` / `SUPABASE_NETWORK_ID` puts
  pg_dump on a named network. Engine/runtime selection still uses `connType`.
