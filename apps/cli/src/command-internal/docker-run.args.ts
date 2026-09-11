import { Option } from "effect";
import { bindMountSpecSource, isBindMountSource } from "./docker-bind-classify.ts";
import type { DockerRunOpts } from "./docker-run.service.ts";

/**
 * Assemble the `docker run` argv from run options. Pure (no Effect) so the
 * argument ordering is unit-testable in isolation.
 */
export function buildDockerArgs(opts: DockerRunOpts): ReadonlyArray<string> {
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
    ...extraHosts.flatMap((h) => ["--add-host", h]),
    ...binds.flatMap((b) => ["-v", b]),
    // Emit the key-only `-e KEY` form so values (e.g. PGPASSWORD) never appear in the host
    // process argv (`ps aux`/`/proc/<pid>/cmdline`, CWE-214); Docker reads each value from the
    // spawning process's own environment, which the layer merges `env` into before spawning.
    ...Object.keys(env).flatMap((k) => ["-e", k]),
    ...securityOpt.flatMap((s) => ["--security-opt", s]),
    ...(Option.isSome(workingDir) ? ["-w", workingDir.value] : []),
    // A one-shot job left running after a client interruption or daemon disconnect must still
    // carry the project labels `stop`/rollback use to discover orphaned containers by label
    // filter (see `docker-remove-all.ts`); empty unless the caller opts in.
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    // `--entrypoint` must precede the image; the remaining `cmd` tokens become its arguments.
    ...(Option.isSome(entrypoint) ? ["--entrypoint", entrypoint.value] : []),
    image,
    ...cmd,
  ];
}

/**
 * Bitbucket Pipelines' Docker-in-Docker runner disallows named volumes and `--security-opt`, so
 * drop named-volume binds and clear `securityOpt` when `BITBUCKET_CLONE_DIR` is set — e.g. the
 * pg-delta Deno-cache named volume is dropped while a `<cwd>:/workspace` bind mount is kept.
 */
export function applyBitbucketDockerFilter(
  opts: DockerRunOpts,
  isBitbucket: boolean,
): DockerRunOpts {
  if (!isBitbucket) return opts;
  return {
    ...opts,
    binds: opts.binds.filter((bind) => isBindMountSource(bindMountSpecSource(bind))),
    securityOpt: [],
  };
}
