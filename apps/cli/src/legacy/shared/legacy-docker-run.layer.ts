import { Effect, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { buildLegacyDockerArgs } from "./legacy-docker-run.args.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import { LegacyDockerRun } from "./legacy-docker-run.service.ts";

// Go's prerequisite hint (`apps/cli-go/internal/utils/docker.go:248`).
const SUGGEST_DOCKER_INSTALL =
  "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop";

export const legacyDockerRunLayer: Layer.Layer<
  LegacyDockerRun,
  never,
  ProcessControl | ChildProcessSpawner
> = Layer.effect(
  LegacyDockerRun,
  Effect.gen(function* () {
    const processControl = yield* ProcessControl;
    const spawner = yield* ChildProcessSpawner;

    return LegacyDockerRun.of({
      run: (opts) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            const args = buildLegacyDockerArgs(opts);
            const command = ChildProcess.make("docker", args, {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
              detached: false,
            });
            // Never embed the spawn error verbatim: its message contains the full
            // argv, including `-e PGPASSWORD=<plaintext>` (CWE-214/209). Emit a
            // fixed, credential-free message that still points at the likely cause.
            const exitCode = yield* spawner.exitCode(command).pipe(
              Effect.mapError(
                () =>
                  new LegacyDockerRunError({
                    message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}`,
                  }),
              ),
            );
            return exitCode;
          }),
        ),
    });
  }),
);
