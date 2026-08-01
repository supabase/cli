/**
 * Assembles `docker create <flags> <image> [cmd...]` argv for the per-service
 * containers Go's `supabase start` creates directly against the Docker Engine
 * SDK (`utils.DockerStart`, `apps/cli-go/internal/utils/docker.go:363-440`).
 *
 * Go never shells out to `docker` — it builds `container.Config` /
 * `container.HostConfig` / `network.NetworkingConfig` structs and calls
 * `Docker.ContainerCreate` over the Engine API. This module is the CLI-shell
 * translation of that same struct surface into `docker create` CLI flags, so
 * every field here is documented against the exact Go struct field (and, where
 * useful, the exact call site) it reproduces.
 *
 * Unlike the Engine API, `docker create`'s argv has no inherent "field order"
 * — Docker parses flags independently of position. The order emitted by
 * {@link legacyBuildStartContainerCreateArgs} below is therefore this module's
 * own fixed, deterministic convention (grouped: identity → env → volumes →
 * ports → healthcheck → restart/security → network → labels →
 * entrypoint/image/cmd), chosen for readability and stable unit-test
 * snapshots — it carries no Go parity obligation, unlike every flag-to-field
 * mapping it emits.
 *
 * Surveyed call sites (every `container.Config{`/`network.NetworkingConfig{`
 * block across the Go source, per the task's "read every one" instruction):
 *   - `apps/cli-go/internal/start/start.go:350-394`   Logflare/analytics
 *   - `apps/cli-go/internal/start/start.go:396-484`   Vector
 *   - `apps/cli-go/internal/start/start.go:486-627`   Kong
 *   - `apps/cli-go/internal/start/start.go:629-851`   GoTrue
 *   - `apps/cli-go/internal/start/start.go:853-901`   Mailpit/Inbucket
 *   - `apps/cli-go/internal/start/start.go:903-958`   Realtime
 *   - `apps/cli-go/internal/start/start.go:960-992`   PostgREST/Rest
 *   - `apps/cli-go/internal/start/start.go:994-1057`  Storage
 *   - `apps/cli-go/internal/start/start.go:1059-1099` Storage ImgProxy
 *   - `apps/cli-go/internal/start/start.go:1110-1146` pg-meta
 *   - `apps/cli-go/internal/start/start.go:1148-1191` Studio
 *   - `apps/cli-go/internal/start/start.go:1193-1268` Pooler
 *   - `apps/cli-go/internal/db/start/start.go:63-131` Postgres (the db container)
 *
 * Fields deliberately NOT modelled, because none of the 13 call sites above
 * set them on `container.Config`/`container.HostConfig` (verified by grepping
 * every block for these field names): `User`, `WorkingDir`, `Tty`, `CapAdd`,
 * `Ulimits`, `ShmSize`. Add them here — following the same "optional field,
 * flag omitted unless present" shape as every other field below — the day a
 * call site actually needs one; there is no value in modelling Docker surface
 * this builder never has to reproduce.
 *
 * One field has no Go struct equivalent at all: {@link LegacyStartContainerSpec.secretFiles}.
 * It exists purely because this module's own "shell out to `docker create`"
 * architecture (unlike Go's direct Engine API calls) has an argv-exposure
 * problem `container.Config`/`container.HostConfig` never had — see that
 * field's doc comment, and `container-lifecycle.ts`'s `legacyCreateContainer`,
 * for the mitigation.
 */

import {
  legacyBindMountSpecSource,
  legacyIsBindMountSource,
} from "../legacy-docker-bind-classify.ts";

/**
 * `container.HealthConfig` (`docker/docker/api/types/container`). Not
 * exported on its own — callers reference it structurally through
 * {@link LegacyStartContainerSpec.healthcheck}; nothing outside this module
 * needs to name the shape directly.
 */
interface LegacyStartHealthcheckSpec {
  /**
   * Go's `HealthConfig.Test` exec form (`["CMD", ...args]`) or shell form
   * (`["CMD-SHELL", script]`). See {@link legacyBuildHealthCmdArg} for exactly
   * how each form becomes the single `--health-cmd` string docker CLI expects.
   */
  readonly test: ReadonlyArray<string>;
  /** `HealthConfig.Interval`, already-whole seconds → `--health-interval <n>s`. */
  readonly intervalSeconds?: number;
  /** `HealthConfig.Timeout` → `--health-timeout <n>s`. */
  readonly timeoutSeconds?: number;
  /** `HealthConfig.Retries` → `--health-retries <n>`. */
  readonly retries?: number;
  /**
   * `HealthConfig.StartPeriod` → `--health-start-period <n>s`. Only Logflare
   * and Mailpit set this (`start.go:371`, `start.go:882`); every other
   * healthcheck leaves Go's zero value, which docker treats as "unset" — so
   * this stays optional and the flag is omitted, not emitted as `0s`.
   */
  readonly startPeriodSeconds?: number;
}

/**
 * `-p <hostPort>:<containerPort>[/<protocol>]` — one
 * `container.HostConfig.PortBindings` entry. Not exported; referenced
 * structurally through {@link LegacyStartContainerSpec.ports}.
 */
interface LegacyStartPortBindingSpec {
  readonly hostPort: string;
  readonly containerPort: string;
  /** Defaults to `"tcp"` (omitted from the flag) — no call site uses `"udp"` today. */
  readonly protocol?: "tcp" | "udp";
}

/**
 * `--expose <containerPort>[/<protocol>]` — one `container.Config.ExposedPorts`
 * entry with no matching `PortBindings` entry (kept separate from
 * {@link LegacyStartPortBindingSpec} on purpose, see the doc comment on
 * {@link LegacyStartContainerSpec.exposedPorts}). Not exported; referenced
 * structurally through {@link LegacyStartContainerSpec.exposedPorts}.
 */
interface LegacyStartExposedPortSpec {
  readonly containerPort: string;
  readonly protocol?: "tcp" | "udp";
}

/**
 * One entry a caller must stage as a HOST temp file and bind-mount read-only
 * into the container — see {@link LegacyStartContainerSpec.secretFiles}'s doc
 * comment for the full contract. Not exported on its own — callers reference
 * it structurally through that field; nothing outside this module needs to
 * name the shape directly.
 */
interface LegacyStartSecretFileSpec {
  /** The fixed path INSIDE the container the caller's generated bind mount targets. */
  readonly containerPath: string;
  /** The secret content to write to a HOST temp file — never emitted into argv. */
  readonly content: string;
}

export interface LegacyStartContainerSpec {
  /** `container.Config.Image` (already resolved/pulled — resolution is out of scope here). */
  readonly image: string;
  /** The 4th `DockerStart` positional argument — `--name`. */
  readonly containerName: string;
  /**
   * `container.Config.Hostname`. Only Logflare sets this (`start.go:353`,
   * `Hostname: "127.0.0.1"`); every other service leaves it unset and relies
   * on Docker's default (the container's own short ID).
   */
  readonly hostname?: string;
  /**
   * `container.Config.Env`, reshaped from Go's `KEY=value` string slice into a
   * map. Emitted as the key-only `-e KEY` form — see the doc comment on
   * {@link legacyBuildStartContainerCreateArgs} — so secret values (JWT
   * secrets, SMTP passwords, API keys — every one of these containers carries
   * at least one) never appear in this process's own argv.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Entrypoint/`Cmd`-script secret content that must land at a specific path
   * INSIDE the container without ever appearing in this process's own
   * `docker create` argv (`ps aux`/`/proc/<pid>/cmdline`, CWE-214/522) — the
   * entrypoint/`Cmd` analogue of {@link env}'s key-only `-e KEY` protection.
   * Kong/Postgres/Supavisor all heredoc or shell-embed secret-bearing content
   * (Kong's `kong.yml`/TLS private key, Postgres's pgsodium root key,
   * Supavisor's rendered `pooler.exs`) directly into their entrypoint script
   * or `Cmd` — safe in Go's Engine-API architecture (never a subprocess's own
   * argv) but not in this port's, which shells out to a real `docker create`.
   *
   * NOT consumed here: {@link legacyBuildStartContainerCreateArgs} stays
   * pure/no-I/O and never reads this field. `container-lifecycle.ts`'s
   * `legacyCreateContainer` is the sole consumer — it writes each entry's
   * `content` to a HOST-side temp file (mode `0644` — world-readable, so the
   * non-root in-container user reading it (e.g. Kong, Postgres) doesn't hit
   * `EACCES` once the bind mount preserves this host mode verbatim; see
   * `legacyStageStartSecretFiles`'s doc comment — in a fresh temp
   * directory) and appends a `<tempHostPath>:<containerPath>:ro,Z` bind (the
   * bind's SOURCE is a generated temp-file path, never the secret itself —
   * safe in argv) to {@link binds} BEFORE this builder ever sees the spec,
   * then removes the temp file/directory once the container is created and
   * started. Generic by design — any future service's spec can set this, not
   * just the three call sites that need it today.
   *
   * Known, accepted limitation (pre-existing — not introduced by CLI-1954's `db start`
   * port, which only extends the SAME already-shared mechanism to one more Postgres
   * entrypoint variant): the generated bind mount's host-side path must be visible to
   * whichever machine the DOCKER DAEMON itself runs on, not just this CLI process —
   * Docker's bind mounts are resolved daemon-side
   * (https://docs.docker.com/engine/storage/bind-mounts/#considerations-and-constraints).
   * A `DOCKER_HOST`/Docker-context pointing at a remote daemon (a scenario this codebase
   * otherwise explicitly supports — see `legacy-hostname.ts`'s `legacyGetHostname`) would
   * see a missing or wrong path there, even though the daemon itself is reachable. Go's
   * own heredoc/`Cmd`-embed delivery has no such requirement (the content travels inside
   * the container-create request itself, over the Engine API), so this is a genuine,
   * Go-parity-relevant gap for that scenario — not merely a stylistic difference. A fix
   * (e.g. `docker cp`-ing the secret into a created-but-not-yet-started container instead
   * of bind-mounting a host path — `docker cp` streams file content over the same
   * connection, so it works against a remote daemon too) would need to change how EVERY
   * `secretFiles` caller's container gets created, not just Postgres's — out of scope for
   * a single command's bootstrap port; tracked as a known gap here rather than fixed
   * silently or left undocumented.
   */
  readonly secretFiles?: ReadonlyArray<LegacyStartSecretFileSpec>;
  /**
   * `container.Config.Entrypoint`'s first element. Docker CLI's `--entrypoint`
   * only accepts a single executable/script name (unlike the Engine API field,
   * which is a full argv array) — the remaining Go `Entrypoint` elements are
   * reproduced via {@link cmd} instead, exactly like the existing `docker run`
   * precedent (`legacy-docker-run.service.ts`'s `entrypoint`/`cmd` split).
   * E.g. Go's `Entrypoint: ["sh", "-c", script]` (Logflare/Vector/Kong/db)
   * becomes `entrypoint: "sh", cmd: ["-c", script]`.
   */
  readonly entrypoint?: string;
  /**
   * Trailing argv tokens placed after the image. Always emitted — unlike the
   * `docker run` precedent's comment (which only ever pairs `cmd` with
   * `entrypoint`), Pooler (`start.go:1234-1237`) sets `container.Config.Cmd`
   * with NO `Entrypoint` at all: it overrides the pooler image's default `CMD`
   * while keeping its own `ENTRYPOINT`. Docker CLI's trailing-tokens-after-image
   * convention already covers both cases identically (args to `--entrypoint`
   * when set, or a `CMD` override of the image default when not), so `cmd` is
   * independent of {@link entrypoint} here.
   */
  readonly cmd?: ReadonlyArray<string>;
  /**
   * `container.HostConfig.Binds` — `"source:target[:mode]"` bind-mount strings
   * or `"volumeName:target"` named-volume strings (Go's `loader.ParseVolume`
   * classification, see {@link legacyIsBindMountSource}). Named-volume
   * creation itself (`Docker.VolumeCreate`, `docker.go:407-415`) is a
   * higher-level orchestration concern, not this pure argv builder's job.
   */
  readonly binds: ReadonlyArray<string>;
  /** `container.HostConfig.VolumesFrom` — ImgProxy only (`start.go:1084`, mounts Storage's volumes). */
  readonly volumesFrom?: ReadonlyArray<string>;
  /**
   * `container.HostConfig.Tmpfs` (`map[mountPath]mountOptions`) — only the
   * Postgres container sets this, and only on PG ≤ 14
   * (`apps/cli-go/internal/db/start/start.go:127-129`:
   * `map[string]string{"/docker-entrypoint-initdb.d": ""}`). An empty options
   * string means "no extra tmpfs mount options" (`--tmpfs <path>` with no
   * `:options` suffix); a non-empty value is joined as `<path>:<options>`.
   */
  readonly tmpfs?: Readonly<Record<string, string>>;
  /**
   * `container.HostConfig.PortBindings` — ports published to the host via
   * `-p`. Distinct from {@link exposedPorts}: publishing a port with `-p`
   * already implies exposing it (docker CLI infers `ExposedPorts` from `-p`
   * the same way Go's own `container.Config.ExposedPorts` happens to overlap
   * with `PortBindings` in the Logflare example, `start.go:373` vs `:377`).
   */
  readonly ports?: ReadonlyArray<LegacyStartPortBindingSpec>;
  /**
   * `container.Config.ExposedPorts` entries that have NO matching
   * `PortBindings` entry — i.e. ports declared reachable on the Docker network
   * but never published to the host. This is a real, recurring pattern, not a
   * one-off: GoTrue (`start.go:825`, port 9999) and Realtime (`start.go:930`,
   * port 4000) expose a port with zero `PortBindings`; Kong exposes 3 ports
   * (`start.go:602-606`) but only ever publishes one of them depending on TLS;
   * Pooler exposes 3 ports (`start.go:1238-1242`) but only ever publishes the
   * one matching its configured pool mode. A single `ports` field (CLI `-p`)
   * cannot express "exposed but not published", so it is kept as its own field
   * rather than folded into {@link ports} with an optional host side.
   */
  readonly exposedPorts?: ReadonlyArray<LegacyStartExposedPortSpec>;
  /** `container.Config.Healthcheck`. Omitted entirely for Kong and PostgREST — see `start.go:975` ("PostgREST does not expose a shell for health check") — so no `--health-*` flags are emitted for those services. */
  readonly healthcheck?: LegacyStartHealthcheckSpec;
  /**
   * `container.HostConfig.RestartPolicy.Name`. Every one of the 13 surveyed
   * call sites uses `container.RestartPolicyUnlessStopped` (verified — grep
   * `RestartPolicy` across `start.go`/`db/start/start.go` returns only
   * `RestartPolicyUnlessStopped`), but the full docker CLI `--restart` enum is
   * supported for completeness/future callers, per the task brief.
   */
  readonly restartPolicy?: "unless-stopped" | "no" | "always" | "on-failure";
  /**
   * `container.HostConfig.SecurityOpt`. Only Vector sets this
   * (`start.go:441`, `"label:disable"`, when mounting a non-root Docker
   * socket) — cleared globally under Bitbucket Pipelines, see
   * {@link legacyApplyBitbucketStartContainerFilter}.
   */
  readonly securityOpt?: ReadonlyArray<string>;
  /**
   * `container.HostConfig.ExtraHosts`. Populated by `DockerStart` itself from
   * the platform-specific `extraHosts` package var (`docker_linux.go`,
   * `docker_darwin.go`, `docker_windows.go`), not by any individual
   * `container.Config` literal — every container gets the same extra hosts.
   * That orchestration (merging in the platform default) is a caller concern;
   * this builder just emits whatever is passed here.
   */
  readonly extraHosts?: ReadonlyArray<string>;
  /**
   * `container.HostConfig.NetworkMode`, resolved by `DockerStart`
   * (`docker.go:379-383`) to either the `--network-id` override or
   * `utils.NetId` — never set per-container in any surveyed call site.
   */
  readonly networkId: string;
  /**
   * `network.NetworkingConfig.EndpointsConfig[NetId].Aliases` — the per-service
   * alias array (e.g. `utils.RealtimeAliases = ["realtime", tenantId]`,
   * `apps/cli-go/internal/utils/config.go:40`). The container's OWN name is
   * already DNS-resolvable on a user-defined network without any alias; this
   * field only adds the short/extra names other containers' env vars and
   * templates reference by.
   */
  readonly networkAliases?: ReadonlyArray<string>;
  /**
   * `container.Config.Labels`, merged in by `DockerStart` itself
   * (`docker.go:372-376`: `CliProjectLabel`/`composeProjectLabel`, both the
   * sanitized project id) rather than set per-service — this builder emits
   * whatever map is passed here, unconditionally.
   */
  readonly labels: Readonly<Record<string, string>>;
}

function formatDockerDurationSeconds(seconds: number): string {
  return `${seconds}s`;
}

/**
 * Quotes a single argv-style argument for safe embedding in a POSIX shell
 * command line: wraps it in single quotes, escaping any embedded single quote
 * as `'\''` (close quote, escaped literal quote, reopen quote) — the standard
 * POSIX-portable technique (equivalent to Python's `shlex.quote`). Arguments
 * containing only characters that never need quoting are returned unchanged
 * for readability.
 */
function legacyShellQuoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_\-./:@%,+=]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Converts Go's `HealthConfig.Test` into the single string `docker create
 * --health-cmd` expects.
 *
 * Docker CLI's `--health-cmd` flag has no exec-form equivalent: whatever
 * string it is given always becomes `HealthConfig.Test = ["CMD-SHELL",
 * value]` on the resulting container (there is no CLI flag that produces the
 * exec-form `["CMD", ...]` Go sometimes uses directly over the Engine API —
 * only a Dockerfile `HEALTHCHECK` instruction or the raw API can do that). So:
 *
 * - `["CMD-SHELL", script]` (pg-meta/Studio, `start.go:1125`/`:1166`) — `script`
 *   is already the exact string Go's own `CMD-SHELL` form would run verbatim
 *   via the container's `/bin/sh -c`; it is forwarded completely unmodified.
 *   No quoting is applied on this side because this string travels as a
 *   single argv element to the spawned `docker` process (no host-side shell
 *   parses it) — only Docker's own eventual in-container `/bin/sh -c
 *   <value>` interprets it, exactly reproducing Go's `Test` value untouched.
 * - `["CMD", ...args]` (exec form — e.g. Logflare's `["CMD", "curl", "-sSfL",
 *   "--head", "-o", "/dev/null", "http://127.0.0.1:4000/health"]`,
 *   `start.go:365-366`) — since `--health-cmd` always produces a `CMD-SHELL`
 *   test, each `args` element is POSIX-shell-quoted individually (via
 *   {@link legacyShellQuoteArg}) and joined with spaces, so that when Docker
 *   later runs `/bin/sh -c "<joined>"` inside the container, the shell
 *   re-splits it back into the exact same argv the exec form specified —
 *   including an argument containing spaces or embedded quotes, which none of
 *   the current 14 services happen to need but which this conversion must
 *   still get right.
 */
export function legacyBuildHealthCmdArg(test: ReadonlyArray<string>): string {
  const [mode, ...rest] = test;
  if (mode === "CMD-SHELL") return rest[0] ?? "";
  return rest.map(legacyShellQuoteArg).join(" ");
}

function formatPortBindingFlag(port: LegacyStartPortBindingSpec): string {
  const suffix = port.protocol === "udp" ? "/udp" : "";
  return `${port.hostPort}:${port.containerPort}${suffix}`;
}

function formatExposedPortFlag(port: LegacyStartExposedPortSpec): string {
  const suffix = port.protocol === "udp" ? "/udp" : "";
  return `${port.containerPort}${suffix}`;
}

function buildHealthcheckArgs(healthcheck: LegacyStartHealthcheckSpec): ReadonlyArray<string> {
  const args: Array<string> = ["--health-cmd", legacyBuildHealthCmdArg(healthcheck.test)];
  if (healthcheck.intervalSeconds !== undefined) {
    args.push("--health-interval", formatDockerDurationSeconds(healthcheck.intervalSeconds));
  }
  if (healthcheck.timeoutSeconds !== undefined) {
    args.push("--health-timeout", formatDockerDurationSeconds(healthcheck.timeoutSeconds));
  }
  if (healthcheck.retries !== undefined) {
    args.push("--health-retries", String(healthcheck.retries));
  }
  if (healthcheck.startPeriodSeconds !== undefined) {
    args.push("--health-start-period", formatDockerDurationSeconds(healthcheck.startPeriodSeconds));
  }
  return args;
}

/**
 * Docker/Podman CLI env vars that configure the CLIENT itself — which daemon
 * it connects to — rather than a value for the container being created. A
 * container spec's own `env` can legitimately need to set one of these (e.g.
 * Vector's `DOCKER_HOST=http://host.docker.internal:<port>`, set by
 * `legacyResolveVectorDockerSocketPlan` for a `tcp`/`npipe` daemon host so
 * Vector can reach the real daemon from inside its own container), but that
 * value must never be inherited by the spawned `docker`/`podman create`
 * PROCESS's own environment: doing so would hijack which daemon that process
 * itself talks to before the container even exists (see
 * `legacyDockerCreateContainer`, `container-lifecycle.ts`, which filters these
 * keys out of the env it hands to the spawned process for exactly this
 * reason). These are not secrets, so unlike the rest of `spec.env` they are
 * safe to emit inline as `-e KEY=value` instead of the key-only form.
 */
const DOCKER_CLIENT_ENV_KEYS: ReadonlySet<string> = new Set([
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_CONTEXT",
  "DOCKER_API_VERSION",
]);

/** Whether `key` configures the Docker/Podman CLI client itself — see {@link DOCKER_CLIENT_ENV_KEYS}. */
export function legacyIsDockerClientEnvKey(key: string): boolean {
  return DOCKER_CLIENT_ENV_KEYS.has(key);
}

/**
 * Assemble the `docker create` argv for one `supabase start` service
 * container. Pure (no Effect) so every flag mapping is unit-testable in
 * isolation, matching the `buildLegacyDockerArgs` (`docker run`) precedent.
 *
 * `"create"` is argv[0] — the caller (`legacy-container-cli.ts`'s
 * `spawnContainerCli`/`containerCliExitCode`) prepends only the `docker`/
 * `podman` binary itself, exactly like `buildLegacyDockerArgs` returning
 * `"run"` as its own argv[0].
 *
 * Env is emitted in the key-only `-e KEY` form (never `-e KEY=value`) for the
 * same CWE-214/209 reason as `buildLegacyDockerArgs`: these containers'
 * env carries JWT secrets, SMTP credentials, API keys, and DB passwords, none
 * of which may appear in this process's own argv (`ps aux` /
 * `/proc/<pid>/cmdline`). The spawned `docker create`'s own child environment
 * supplies each value — a later caller's responsibility, not this builder's.
 * The exception is {@link legacyIsDockerClientEnvKey} keys, which are emitted
 * inline as `-e KEY=value` instead — see that function's doc comment.
 */
export function legacyBuildStartContainerCreateArgs(
  spec: LegacyStartContainerSpec,
): ReadonlyArray<string> {
  return [
    "create",
    "--name",
    spec.containerName,
    ...(spec.hostname === undefined ? [] : ["--hostname", spec.hostname]),
    ...Object.entries(spec.env).flatMap(([key, value]) =>
      legacyIsDockerClientEnvKey(key) ? ["-e", `${key}=${value}`] : ["-e", key],
    ),
    ...spec.binds.flatMap((bind) => ["-v", bind]),
    ...(spec.volumesFrom ?? []).flatMap((source) => ["--volumes-from", source]),
    ...Object.entries(spec.tmpfs ?? {}).flatMap(([path, options]) => [
      "--tmpfs",
      options.length > 0 ? `${path}:${options}` : path,
    ]),
    ...(spec.ports ?? []).flatMap((port) => ["-p", formatPortBindingFlag(port)]),
    ...(spec.exposedPorts ?? []).flatMap((port) => ["--expose", formatExposedPortFlag(port)]),
    ...(spec.healthcheck === undefined ? [] : buildHealthcheckArgs(spec.healthcheck)),
    ...(spec.restartPolicy === undefined ? [] : ["--restart", spec.restartPolicy]),
    ...(spec.securityOpt ?? []).flatMap((opt) => ["--security-opt", opt]),
    ...(spec.extraHosts ?? []).flatMap((host) => ["--add-host", host]),
    "--network",
    spec.networkId,
    ...(spec.networkAliases ?? []).flatMap((alias) => ["--network-alias", alias]),
    ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    // `--entrypoint` must precede the image (it is a `docker create` flag).
    ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
    spec.image,
    ...(spec.cmd ?? []),
  ];
}

/**
 * Mirror Go's `DockerStart` Bitbucket Pipelines handling
 * (`apps/cli-go/internal/utils/docker.go:400-405`): when `BITBUCKET_CLONE_DIR`
 * is set, that runner disallows named volumes and `--security-opt`, so Go
 * drops named-volume binds and clears `SecurityOpt` before starting any
 * container. Mirrors `legacyApplyBitbucketDockerFilter`
 * (`legacy-docker-run.args.ts`) for the `docker create` shape — e.g. the
 * Postgres container's `<projectId>_db:/var/lib/postgresql/data` named-volume
 * bind is dropped while a bind-mount stays; Vector's non-root Docker-socket
 * bind mount (already a bind mount, not a named volume) is unaffected either
 * way, but its `SecurityOpt: ["label:disable"]` is cleared.
 *
 * `volumesFrom` and `tmpfs` are untouched: Go's Bitbucket branch only ever
 * reassigns `hostConfig.Binds` and clears `hostConfig.SecurityOpt`
 * (`docker.go:401-405`) — it does not touch `VolumesFrom` or `Tmpfs`.
 */
export function legacyApplyBitbucketStartContainerFilter(
  spec: LegacyStartContainerSpec,
  isBitbucket: boolean,
): LegacyStartContainerSpec {
  if (!isBitbucket) return spec;
  return {
    ...spec,
    binds: spec.binds.filter((bind) => legacyIsBindMountSource(legacyBindMountSpecSource(bind))),
    securityOpt: [],
  };
}
