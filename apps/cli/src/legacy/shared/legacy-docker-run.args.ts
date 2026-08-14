import { Option } from "effect";
import {
  legacyBindMountSpecSource,
  legacyIsBindMountSource,
} from "./legacy-docker-bind-classify.ts";
import type { LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

/**
 * Assemble the `docker run` argv from run options. Pure (no Effect) so the
 * argument ordering is unit-testable in isolation.
 */
export function buildLegacyDockerArgs(opts: LegacyDockerRunOpts): ReadonlyArray<string> {
  const { network, binds, env, securityOpt, extraHosts, workingDir, image, cmd } = opts;
  const entrypoint = opts.entrypoint ?? Option.none<string>();
  const labels = opts.labels ?? {};
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
    // `HostConfig.ExtraHosts` (DockerStart) → docker CLI `--add-host`.
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
    // `DockerStart` unconditionally sets `com.supabase.cli.project` and
    // `com.docker.compose.project` on `config.Labels` for EVERY container it
    // starts, one-shot jobs included — `supabase stop` and this shell's own rollback both discover
    // orphaned containers by that project-label filter
    // (`legacy-docker-remove-all.ts`), so a one-shot job left running after a
    // client interruption/daemon disconnect must carry the same labels to be
    // found. Empty unless the caller opts in (review: Codex, PR #6022).
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    // `--entrypoint` must precede the image (it is a `docker run` flag); the
    // remaining `cmd` tokens become the entrypoint's args, mirroring Go's
    // `Entrypoint: [value, ...cmd]`.
    ...(Option.isSome(entrypoint) ? ["--entrypoint", entrypoint.value] : []),
    image,
    ...cmd,
  ];
}

/**
 * Mirror `DockerStart` Bitbucket Pipelines handling:
 * when `BITBUCKET_CLONE_DIR` is set,
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
    binds: opts.binds.filter((bind) => legacyIsBindMountSource(legacyBindMountSpecSource(bind))),
    securityOpt: [],
  };
}
