/**
 * Builds `docker create` argv for the per-service containers `supabase start` launches.
 *
 * Flag order is a fixed convention (identity, env, volumes, ports, healthcheck, restart and
 * security, network, labels, entrypoint/image/cmd) so unit-test snapshots stay stable.
 */

import type { PlatformError, Stream } from "effect";

import { bindMountSpecSource, isBindMountSource } from "../docker-bind-classify.ts";

interface StartHealthcheckSpec {
  /**
   * Exec form (`["CMD", ...args]`) or shell form (`["CMD-SHELL", script]`); see
   * {@link buildHealthCmdArg} for how each becomes the single `--health-cmd` string.
   */
  readonly test: ReadonlyArray<string>;
  /** Emitted as `--health-interval <n>s`. */
  readonly intervalSeconds?: number;
  /** Emitted as `--health-timeout <n>s`. */
  readonly timeoutSeconds?: number;
  /** Emitted as `--health-retries <n>`. */
  readonly retries?: number;
  /** Emitted as `--health-start-period <n>s`; omitted when unset. */
  readonly startPeriodSeconds?: number;
}

/** One `-p <hostPort>:<containerPort>[/<protocol>]` entry. */
interface StartPortBindingSpec {
  readonly hostPort: string;
  readonly containerPort: string;
  /** Defaults to `"tcp"`, omitted from the flag. */
  readonly protocol?: "tcp" | "udp";
}

/** One `--expose <containerPort>[/<protocol>]` entry, with no matching `-p` publish; see {@link StartContainerSpec.exposedPorts}. */
interface StartExposedPortSpec {
  readonly containerPort: string;
  readonly protocol?: "tcp" | "udp";
}

/** One entry packed into a container's in-memory secret tar archive; see {@link StartContainerSpec.secretFiles}. */
interface StartSecretFileSpec {
  /** The path to materialize inside the container. */
  readonly containerPath: string;
  /** Never written to host disk or argv; only the in-memory archive. */
  readonly content: string;
}

/** One tar archive to extract into the created-but-not-yet-started container; see {@link StartContainerSpec.preStartArchives}. */
interface StartPreStartArchiveSpec {
  /** The directory inside the container to unpack into, i.e. `docker cp - <id>:<containerPath>`. */
  readonly containerPath: string;
  /**
   * A stream rather than a host path: it keeps the archive's storage decisions with the
   * producer, and `createContainer` needs no `FileSystem` to deliver it.
   */
  readonly tar: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}

export interface StartContainerSpec {
  /** Already resolved/pulled; resolution is out of scope here. */
  readonly image: string;
  /**
   * An empty string lets Docker auto-generate a name; {@link buildStartContainerCreateArgs}
   * omits `--name` entirely in that case, since Docker rejects an explicit empty value.
   */
  readonly containerName: string;
  /** Omitted uses Docker's default (the container's own short ID). */
  readonly hostname?: string;
  /**
   * Emitted as the key-only `-e KEY` form (see {@link buildStartContainerCreateArgs}) so
   * secret values never appear in this process's own argv.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Secret content that must land at a specific path inside the container without ever
   * appearing in this process's own `docker create` argv. Not consumed here —
   * {@link buildStartContainerCreateArgs} stays pure/no-I/O; `container-lifecycle.ts`'s
   * `createContainer` is the sole consumer, delivering it via `docker cp` after create and
   * before start, which works identically against a local or remote daemon.
   */
  readonly secretFiles?: ReadonlyArray<StartSecretFileSpec>;
  /**
   * Unpacked into the container after `docker create` and before `docker start`, via a
   * tar-stream `docker cp` that preserves each member's uid/gid — unlike a host-path `docker cp`,
   * which resets ownership to root and a restored Postgres data directory cannot survive.
   *
   * Not consumed here — {@link buildStartContainerCreateArgs} stays pure/no-I/O.
   * `container-lifecycle.ts`'s `createContainer` is the sole consumer.
   */
  readonly preStartArchives?: ReadonlyArray<StartPreStartArchiveSpec>;
  /**
   * Docker CLI's `--entrypoint` accepts only a single executable/script name; a multi-element
   * entrypoint (e.g. `["sh", "-c", script]`) splits into `entrypoint: "sh"` and
   * `cmd: ["-c", script]`.
   */
  readonly entrypoint?: string;
  /**
   * Trailing argv tokens placed after the image; independent of {@link entrypoint} — a spec can
   * set `cmd` alone to override just the image's default `CMD` while keeping its `ENTRYPOINT`.
   */
  readonly cmd?: ReadonlyArray<string>;
  /**
   * `"source:target[:mode]"` bind-mount strings or `"volumeName:target"` named-volume strings
   * (see {@link isBindMountSource}). Named-volume creation itself is a higher-level
   * orchestration concern, not this pure argv builder's job.
   */
  readonly binds: ReadonlyArray<string>;
  /** Mounts another container's volumes (used to share Storage's volumes with ImgProxy). */
  readonly volumesFrom?: ReadonlyArray<string>;
  /**
   * Maps mount path to mount options. An empty options string omits the `:options` suffix on
   * `--tmpfs <path>`; a non-empty value is joined as `<path>:<options>`.
   */
  readonly tmpfs?: Readonly<Record<string, string>>;
  /**
   * Ports published to the host via `-p`. Distinct from {@link exposedPorts}: publishing a
   * port with `-p` already implies exposing it.
   */
  readonly ports?: ReadonlyArray<StartPortBindingSpec>;
  /**
   * Ports declared reachable on the Docker network but never published to the host. Kept
   * separate from {@link ports} because a single `-p`-based field cannot express "exposed but
   * not published".
   */
  readonly exposedPorts?: ReadonlyArray<StartExposedPortSpec>;
  /** Omitted for services with no way to health-check themselves (e.g. no shell in the image). */
  readonly healthcheck?: StartHealthcheckSpec;
  /** Every current caller uses `"unless-stopped"`; the full `--restart` enum is supported for future callers. */
  readonly restartPolicy?: "unless-stopped" | "no" | "always" | "on-failure";
  /**
   * `--rm` only fires once the container's own process exits on its own; it does not make an
   * explicit remove redundant for a still-running container.
   */
  readonly autoRemove?: boolean;
  /** Cleared globally under Bitbucket Pipelines; see {@link applyBitbucketStartContainerFilter}. */
  readonly securityOpt?: ReadonlyArray<string>;
  /** Merging in the platform default extra host is a caller concern; this builder just emits whatever is passed here. */
  readonly extraHosts?: ReadonlyArray<string>;
  /** The Docker network every container joins; resolved by the caller. */
  readonly networkId: string;
  /**
   * The container's own name is already DNS-resolvable on a user-defined network; this field
   * only adds extra names other containers' env vars and templates reference by.
   */
  readonly networkAliases?: ReadonlyArray<string>;
  /** The caller merges in the project-identity labels; this builder emits whatever map is passed here. */
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
function shellQuoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_\-./:@%,+=]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Converts a healthcheck `Test` array into the single string `docker create --health-cmd`
 * expects — there's no CLI equivalent for an exec-form test, so a `["CMD-SHELL", script]` test
 * forwards unmodified, and a `["CMD", ...args]` test has each argument shell-quoted (see
 * {@link shellQuoteArg}) and joined with spaces so Docker's own `/bin/sh -c` re-splits it back
 * into the same argv.
 */
export function buildHealthCmdArg(test: ReadonlyArray<string>): string {
  const [mode, ...rest] = test;
  if (mode === "CMD-SHELL") return rest[0] ?? "";
  return rest.map(shellQuoteArg).join(" ");
}

function formatPortBindingFlag(port: StartPortBindingSpec): string {
  const suffix = port.protocol === "udp" ? "/udp" : "";
  return `${port.hostPort}:${port.containerPort}${suffix}`;
}

function formatExposedPortFlag(port: StartExposedPortSpec): string {
  const suffix = port.protocol === "udp" ? "/udp" : "";
  return `${port.containerPort}${suffix}`;
}

function buildHealthcheckArgs(healthcheck: StartHealthcheckSpec): ReadonlyArray<string> {
  const args: Array<string> = ["--health-cmd", buildHealthCmdArg(healthcheck.test)];
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
 * Docker/Podman CLI env vars that configure the client itself (which daemon it connects to),
 * rather than a container env value. A spec's own `env` can legitimately set one of these (e.g.
 * Vector's container-facing `DOCKER_HOST`), but it must never reach the spawned `docker create`
 * process's own environment, which would hijack which daemon that process itself talks to.
 * These aren't secrets, so unlike the rest of `spec.env` they're safe to emit inline.
 */
const DOCKER_CLIENT_ENV_KEYS: ReadonlySet<string> = new Set([
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_CONTEXT",
  "DOCKER_API_VERSION",
  // Locates `config.json`/the context store. Without this, a project dotenv setting only
  // `DOCKER_CONFIG` (no `DOCKER_HOST`/`DOCKER_CONTEXT`) would never reach `process.env`, so
  // hostname resolution and spawned subprocesses would silently fall back to the ambient
  // `~/.docker` config instead of the project-selected one.
  "DOCKER_CONFIG",
]);

/** Whether `key` configures the Docker/Podman CLI client itself — see {@link DOCKER_CLIENT_ENV_KEYS}. */
export function isDockerClientEnvKey(key: string): boolean {
  return DOCKER_CLIENT_ENV_KEYS.has(key);
}

/**
 * Assembles the `docker create` argv for one `supabase start` service container. Pure (no
 * Effect) so every flag mapping is unit-testable in isolation. The caller prepends only the
 * `docker`/`podman` binary itself.
 *
 * Env is emitted in the key-only `-e KEY` form, never `-e KEY=value`, so secret values never
 * appear in this process's own argv; the spawned `docker create` process's own environment
 * supplies each value. {@link isDockerClientEnvKey} keys are the exception, emitted inline.
 */
export function buildStartContainerCreateArgs(spec: StartContainerSpec): ReadonlyArray<string> {
  return [
    "create",
    ...(spec.containerName.length === 0 ? [] : ["--name", spec.containerName]),
    ...(spec.autoRemove === true ? ["--rm"] : []),
    ...(spec.hostname === undefined ? [] : ["--hostname", spec.hostname]),
    ...Object.entries(spec.env).flatMap(([key, value]) =>
      isDockerClientEnvKey(key) ? ["-e", `${key}=${value}`] : ["-e", key],
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
 * Bitbucket Pipelines runners disallow named volumes and `--security-opt`, so this drops
 * named-volume binds (bind mounts stay) and clears `securityOpt`. `volumesFrom` and `tmpfs` are
 * untouched.
 */
export function applyBitbucketStartContainerFilter(
  spec: StartContainerSpec,
  isBitbucket: boolean,
): StartContainerSpec {
  if (!isBitbucket) return spec;
  return {
    ...spec,
    binds: spec.binds.filter((bind) => isBindMountSource(bindMountSpecSource(bind))),
    securityOpt: [],
  };
}
