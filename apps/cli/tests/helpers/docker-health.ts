/** What Docker records for a HEALTHCHECK probe it could not start on a host where `docker exec` fails. */
export const EXEC_FAILURE_OUTPUT =
  "OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1: unknown";

/** Moby records a probe that outlived its timeout with the same exit code as an exec-start failure. */
export const PROBE_TIMEOUT_OUTPUT = "Health check exceeded timeout (2s)";

export interface RecordedProbe {
  readonly exitCode: number;
  readonly output: string;
}

/** The `docker container inspect --format '{{json .State}}'` shape, including `Health.Log`. */
export function inspectedState(
  opts: {
    readonly health?: string;
    readonly probes?: ReadonlyArray<RecordedProbe>;
    readonly status?: string;
    readonly running?: boolean;
  } = {},
): string {
  return JSON.stringify({
    Status: opts.status ?? "running",
    Running: opts.running ?? true,
    ExitCode: 0,
    OOMKilled: false,
    ...(opts.health === undefined
      ? {}
      : {
          Health: {
            Status: opts.health,
            FailingStreak: opts.health === "healthy" ? 0 : (opts.probes?.length ?? 0),
            Log: (opts.probes ?? []).map((probe) => ({
              Start: "2026-10-27T10:00:00.000000000Z",
              End: "2026-10-27T10:00:00.100000000Z",
              ExitCode: probe.exitCode,
              Output: probe.output,
            })),
          },
        }),
  });
}

/** A running container whose HEALTHCHECK has never been able to start. */
export const EXEC_FAILED_STATE = inspectedState({
  health: "unhealthy",
  probes: [{ exitCode: -1, output: EXEC_FAILURE_OUTPUT }],
});
