import { Option } from "effect";
import type { LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

/**
 * Assemble the `docker run` argv from run options. Pure (no Effect) so the
 * argument ordering — Go parity with `apps/cli-go/internal/db/test/test.go` +
 * `utils.DockerRunOnceWithConfig` — is unit-testable in isolation.
 */
export function buildLegacyDockerArgs(opts: LegacyDockerRunOpts): ReadonlyArray<string> {
  const { network, binds, env, securityOpt, workingDir, image, cmd } = opts;
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
    ...binds.flatMap((b) => ["-v", b]),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...securityOpt.flatMap((s) => ["--security-opt", s]),
    ...(Option.isSome(workingDir) ? ["-w", workingDir.value] : []),
    image,
    ...cmd,
  ];
}
