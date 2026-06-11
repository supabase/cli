import { Option } from "effect";
import type { LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

/**
 * Assemble the `docker run` argv from run options. Pure (no Effect) so the
 * argument ordering — Go parity with `apps/cli-go/internal/db/test/test.go` +
 * `utils.DockerRunOnceWithConfig` — is unit-testable in isolation.
 */
export function buildLegacyDockerArgs(opts: LegacyDockerRunOpts): ReadonlyArray<string> {
  const { network, binds, env, securityOpt, extraHosts, workingDir, image, cmd } = opts;
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
    image,
    ...cmd,
  ];
}
