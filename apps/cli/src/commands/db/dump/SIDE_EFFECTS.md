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
| `supabase/.temp/pooler-url`       | plain text | `--linked` when the direct host is unreachable and the target ref is the linked ref (pooler URL)                                             |
| `~/.supabase/access-token`        | plain text | `--linked` when `SUPABASE_ACCESS_TOKEN` unset                                                                                                |
| `supabase/.temp/project-ref`      | plain text | `--linked` (and the default target) ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`/config.toml `project_id`) is set |
| `supabase/.env*`                  | dotenv     | always (project env, feeds `SUPABASE_DB_PASSWORD` / `PG*`)                                                                                   |
| `PGSSL*` PEM, `pg_service.conf`   | PEM, libpq | remote target, when set: `pg_service.conf`, plus the PEM files on the pooler temp-role probe and in `pg_dump`                                |

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

| Variable                                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_PASSWORD` (`DB_PASSWORD` viper key; `--password`/`-p` overrides) | remote DB password                                                                                                                                                                                                                                                                                                                                          |
| `SUPABASE_ACCESS_TOKEN`                                                       | `--linked` auth                                                                                                                                                                                                                                                                                                                                             |
| `SUPABASE_DB_ORIOLEDB_VERSION`                                                | overrides `db.orioledb_version`, selecting the OrioleDB `pg_dump` image                                                                                                                                                                                                                                                                                     |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION`                                      | deprecated alias of `SUPABASE_DB_ORIOLEDB_VERSION`, used only while that is unset; when set, stderr gets `WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.`                                                                                                                  |
| `BITBUCKET_CLONE_DIR`                                                         | clears the `label:disable` security option that mounted TLS files add                                                                                                                                                                                                                                                                                       |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                            | rewrite the pg image registry for compose dumps; stack dumps use the catalog image pin unchanged                                                                                                                                                                                                                                                            |
| `SUPABASE_USE_SLIM_IMAGES`                                                    | resolve the current Postgres pin from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, and flag-off `15.8.1.085` stay on docker.io; a failed GHCR pull falls back to the same tag and digest on `public.ecr.aws/supabase/cli` |
| `DOCKER_HOST`                                                                 | docker daemon endpoint                                                                                                                                                                                                                                                                                                                                      |
| `MSYSTEM`, `TERM_PROGRAM`                                                     | suppress the piped-stdout non-ASCII warning in MSYS/mintty sessions                                                                                                                                                                                                                                                                                         |
| `PG*` libpq                                                                   | linked-project TLS, timeout, service; see `db push`. An invalid value fails before `pg_dump` runs; a remote target also hands them to `pg_dump` (see Notes)                                                                                                                                                                                                 |
| `SSL_CERT_FILE`, `SSL_CERT_DIR`                                               | a native `pg_dump` on libpq 16+ keeps `sslrootcert=system` when either is set; libpq 15 uses only `SSL_CERT_FILE`                                                                                                                                                                                                                                           |

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

### Target default warning

A run that passes none of `--local`, `--linked`, `--db-url` or `--project-ref` (in any form, including `--linked=false`) writes one line to **stderr** after flag validation and before the connection is resolved, in every `--output-format`, when a linked project ref is configured (from `SUPABASE_PROJECT_ID` or the link file). An unlinked run prints only the existing not-linked error. stdout is unchanged. The next major version targets the local database by default.

```
Warning: supabase db dump will target the local database by default in the next major version. Pass --linked to keep targeting the linked project.
```

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
  env var simply leaves unused on a non-linked target). The saved `.temp/pooler-url`
  applies only when the target ref is the linked ref; a `--project-ref` or
  `SUPABASE_PROJECT_ID` naming another project fetches that project's pooler config from the
  Management API.
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
- **TLS settings in `pg_dump`.** A remote target (linked project or remote `--db-url`)
  gets the resolved `sslmode` and connect timeout, the root cert only under
  `require`/`verify-ca`/`verify-full`, and the client cert and key unless the key needs
  `sslpassword` (libpq reads no passphrase from the environment). `system` pins
  `verify-full`. Verifying without a root cert, or with `system`, uses the image's trust
  store in a container and the host's CA bundle for a native `pg_dump`, which keeps
  libpq's `~/.postgresql/root.crt` when no root cert is set, keeps `system` on libpq 16+
  when `SSL_CERT_FILE` or `SSL_CERT_DIR` is set (libpq 15 uses only `SSL_CERT_FILE`),
  and also inherits the shell's `PG*`. A container mounts the PEM files read-only under
  `/run/supabase/tls` (the Docker daemon must see the same paths) and copies the key to
  a private file. A missing or non-file path, or one containing `:` past a Windows
  drive, fails before the container starts.
- **Stack backend host rewrite.** Stack dumps always use catalog `pg_dump` (native
  artifact or a one-shot of the same image). `--local` native rewrites loopback to
  `127.0.0.1`. Native `--linked` / `--db-url` keep
  the resolved host. Managed `--local` dumps run through the stack's own command runtime
  against its endpoint without a rewrite. Other container dumps rewrite any loopback host
  (whatever its port) to `host.docker.internal` unless the tool container shares the Linux
  host network, and always run on the host network unless `--network-id` is set. Legacy
  container dumps rewrite loopback only when `--network-id` / `SUPABASE_NETWORK_ID` puts
  pg_dump on a named network. Engine/runtime selection still uses `connType`.
