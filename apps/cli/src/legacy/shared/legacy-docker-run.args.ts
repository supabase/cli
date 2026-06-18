import { Option } from "effect";
import type { LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

/**
 * Assemble the `docker run` argv from run options. Pure (no Effect) so the
 * argument ordering — Go parity with `apps/cli-go/internal/db/test/test.go` +
 * `utils.DockerRunOnceWithConfig` — is unit-testable in isolation.
 */
export function buildLegacyDockerArgs(opts: LegacyDockerRunOpts): ReadonlyArray<string> {
  const { network, binds, env, securityOpt, extraHosts, workingDir, image, cmd } = opts;
  const entrypoint = opts.entrypoint ?? Option.none<string>();
  const networkArgs: ReadonlyArray<string> =
    network._tag === "host"
      ? ["--network", "host"]
      : network._tag === "named"
        ? ["--network", network.name]
        : [];
  return [
    "run",
    "--rm",
    ...networkArgs,
    // Go's `HostConfig.ExtraHosts` (DockerStart) → docker CLI `--add-host`.
    ...extraHosts.flatMap((h) => ["--add-host", h]),
    ...binds.flatMap((b) => ["-v", b]),
    // Emit the key-only `-e KEY` form so values (e.g. PGPASSWORD) never appear
    // in the host process argv (`ps aux` / `/proc/<pid>/cmdline`). Docker reads
    // each value from the spawning process's environment instead — the layer
    // merges `env` into the docker child's environment before spawning. Go avoids
    // this exposure entirely by passing `container.Config.Env` over the Docker
    // socket API; this is the CLI-shell equivalent (CWE-214).
    ...Object.keys(env).flatMap((k) => ["-e", k]),
    ...securityOpt.flatMap((s) => ["--security-opt", s]),
    ...(Option.isSome(workingDir) ? ["-w", workingDir.value] : []),
    // `--entrypoint` must precede the image (it is a `docker run` flag); the
    // remaining `cmd` tokens become the entrypoint's args, mirroring Go's
    // `Entrypoint: [value, ...cmd]`.
    ...(Option.isSome(entrypoint) ? ["--entrypoint", entrypoint.value] : []),
    image,
    ...cmd,
  ];
}

// Go's `loader.ParseVolume` bind-vs-named classification (docker/cli `volumespec`
// `isFilePath`): a bind's source is a bind mount when it looks like a file path
// (starts with `.`, `/`, `~`, or a Windows drive/UNC); otherwise it is a named volume.
function isBindMountSource(source: string): boolean {
  return /^[.~/]/.test(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");
}

/**
 * Mirror Go's `DockerStart` Bitbucket Pipelines handling
 * (`apps/cli-go/internal/utils/docker.go:275-304`): when `BITBUCKET_CLONE_DIR` is set,
 * that runner disallows named volumes and `--security-opt`, so Go drops named-volume
 * binds and clears `SecurityOpt` before starting any container. Applied globally to
 * every legacy docker run (matching Go's placement) — e.g. the pg-delta Deno-cache
 * named volume is dropped while the `<cwd>:/workspace` bind mount is kept.
 */
export function legacyApplyBitbucketDockerFilter(
  opts: LegacyDockerRunOpts,
  isBitbucket: boolean,
): LegacyDockerRunOpts {
  if (!isBitbucket) return opts;
  return {
    ...opts,
    binds: opts.binds.filter((bind) => isBindMountSource(bind.split(":")[0] ?? "")),
    securityOpt: [],
  };
}
