import * as Net from "node:net";
import { Duration, Effect, Match, Ref, Schedule } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { defaults, type HealthCheckConfig, type ProbeConfig } from "./ServiceDef.ts";

const executeProbe = (
  probe: ProbeConfig,
  timeoutSeconds: number,
): Effect.Effect<
  boolean,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> => {
  return Match.valueTags(probe, {
    Http: (probe) =>
      HttpClient.get(`${probe.scheme}://${probe.host}:${probe.port}${probe.path}`).pipe(
        Effect.timeout(Duration.seconds(timeoutSeconds)),
        Effect.map((res) => res.status >= 200 && res.status < 300),
        Effect.orElseSucceed(() => false),
      ),
    Exec: (probe) => {
      const cmd = ChildProcess.make(probe.command, probe.args, {
        env: probe.env,
        extendEnv: true,
      });
      return ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.exitCode(cmd).pipe(
          Effect.map((code) => code === 0),
          Effect.timeout(Duration.seconds(timeoutSeconds)),
          Effect.map((opt) => opt ?? false),
        ),
      ).pipe(Effect.orElseSucceed(() => false));
    },
    Tcp: (probe) =>
      Effect.callback<boolean>((resume) => {
        const socket = Net.createConnection({ host: probe.host, port: probe.port });
        socket.once("connect", () => {
          socket.destroy();
          resume(Effect.succeed(true));
        });
        socket.once("error", () => {
          socket.destroy();
          resume(Effect.succeed(false));
        });
        return Effect.sync(() => socket.destroy());
      }).pipe(
        Effect.timeout(Duration.seconds(timeoutSeconds)),
        Effect.map((opt) => opt ?? false),
        Effect.orElseSucceed(() => false),
      ),
  });
};

export interface HealthProbeCallbacks {
  readonly onHealthy: Effect.Effect<void>;
  readonly onUnhealthy: Effect.Effect<void>;
}

export const runHealthProbe = (config: {
  readonly name: string;
  readonly healthCheck: HealthCheckConfig;
  readonly callbacks: HealthProbeCallbacks;
}): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const hc = config.healthCheck;
    const initialDelay = hc.initialDelaySeconds ?? defaults.healthCheck.initialDelaySeconds;
    const period = hc.periodSeconds ?? defaults.healthCheck.periodSeconds;
    const timeout = hc.timeoutSeconds ?? defaults.healthCheck.timeoutSeconds;
    const successThreshold = hc.successThreshold ?? defaults.healthCheck.successThreshold;
    const failureThreshold = hc.failureThreshold ?? defaults.healthCheck.failureThreshold;
    const startupFailureThreshold = hc.startupFailureThreshold ?? failureThreshold;

    if (initialDelay > 0) {
      yield* Effect.sleep(Duration.seconds(initialDelay));
    }

    const counters = yield* Ref.make({ successes: 0, failures: 0 });
    let phase: "Starting" | "Healthy" | "Unhealthy" = "Starting";
    let hasEverBeenHealthy = false;

    yield* Effect.repeat(
      Effect.gen(function* () {
        const success = yield* executeProbe(hc.probe, timeout);

        if (success) {
          const { successes } = yield* Ref.getAndUpdate(counters, (c) => ({
            successes: c.successes + 1,
            failures: 0,
          }));
          if (phase !== "Healthy" && successes + 1 >= successThreshold) {
            phase = "Healthy";
            hasEverBeenHealthy = true;
            yield* config.callbacks.onHealthy;
          }
        } else {
          const { failures } = yield* Ref.getAndUpdate(counters, (c) => ({
            successes: 0,
            failures: c.failures + 1,
          }));
          const activeFailureThreshold = hasEverBeenHealthy
            ? failureThreshold
            : startupFailureThreshold;
          if (phase !== "Unhealthy" && failures + 1 >= activeFailureThreshold) {
            phase = "Unhealthy";
            yield* config.callbacks.onUnhealthy;
          }
        }
      }),
      Schedule.spaced(Duration.seconds(period)),
    );
  }).pipe(Effect.asVoid);
