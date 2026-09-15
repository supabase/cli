import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makeTempCliStackProject,
  overrideStackPorts,
  requireCliSuccess,
  runSupabaseEffect,
} from "../../../tests/helpers/cli.ts";
import { sanitizeProjectId } from "../../command-internal/docker-ids.ts";

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const STOP_COMMAND_TIMEOUT_MS = 120_000;
const DOCKER_INSPECT_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
// The stack project's teardown is released inside the test's own scope, so its budget is part
// of this timeout rather than a separate hook timeout.
const STOP_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  CLI_COMMAND_TIMEOUT_MS +
  STOP_COMMAND_TIMEOUT_MS +
  DOCKER_INSPECT_TIMEOUT_MS +
  CLEANUP_TIMEOUT_MS +
  LIFECYCLE_MARGIN_MS;

class StackProjectSetupError extends Data.TaggedError("StackProjectSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StackProjectCleanupError extends Data.TaggedError("StackProjectCleanupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StackPortOverrideError extends Data.TaggedError("StackPortOverrideError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class DockerInspectError extends Data.TaggedError("DockerInspectError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Owns one temp stack project for `use`. Teardown runs `stop --no-backup` against whatever the
 * test left behind and its failures are swallowed, so a stack the test already stopped can't
 * fail the run.
 */
const withTempStackProject = <A, E, R>(
  use: (project: Awaited<ReturnType<typeof makeTempCliStackProject>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackProjectSetupError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => makeTempCliStackProject("sb-stop-e2e-"),
      catch: (cause) =>
        new StackProjectSetupError({ message: "temp stack project setup failed", cause }),
    }),
    use,
    (project) =>
      Effect.tryPromise({
        try: () => project.cleanup(),
        catch: (cause) =>
          new StackProjectCleanupError({ message: "temp stack project cleanup failed", cause }),
      }).pipe(Effect.ignore),
  );

const overrideStackPortsIn = (projectDir: string) =>
  Effect.tryPromise({
    try: () => overrideStackPorts(projectDir),
    catch: (cause) =>
      new StackPortOverrideError({ message: `failed to override ports in ${projectDir}`, cause }),
  });

/**
 * Container ids still carrying the project's own label. A non-zero `docker ps` exit fails the
 * test rather than reporting an empty listing, which would let the teardown assertion pass
 * without Docker having answered.
 */
const remainingContainerIds = (projectId: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--format",
          "{{.ID}}",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      ),
    );
    // Concurrent, not sequential: awaiting the exit code first can leave a fast process's
    // already-ended stdio pipes empty for a late subscriber.
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new DockerInspectError({
        message: `docker ps exited ${exitCode}: ${stderr.trim()}`,
      });
    }
    return stdout.trim();
  }).pipe(Effect.scoped, Effect.timeout(DOCKER_INSPECT_TIMEOUT_MS));

// `stop` never calls the Management API — it talks directly to the real local Docker stack
// `start` creates. The suite gates on `SUPABASE_ACCESS_TOKEN` purely as a "real e2e runner"
// signal, which also guarantees a Docker daemon; see AGENTS.md's "e2e tests" section.
describe("supabase stop (e2e)", () => {
  it.live(
    "starts a real local stack, then stops it and removes its containers",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const projectDir = project.dir;
          // No `project_id` override, so the cli resolves it from the workdir
          // basename (see docker-ids.ts).
          const projectId = path.basename(projectDir);

          const init = yield* runSupabaseEffect(["init"], {
            cwd: projectDir,
            exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
          });
          requireCliSuccess(init, "init setup");
          yield* overrideStackPortsIn(projectDir);

          // Exclude heavy, irrelevant services (Studio's Next.js build, the logging pipeline);
          // `stop`'s label-filtering only needs at least one real container to exist.
          const start = yield* runSupabaseEffect(
            ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
            { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
          );
          requireCliSuccess(start, "start setup");

          // Confirm the stack is actually up before testing `stop` against it.
          const before = yield* runSupabaseEffect(["status"], {
            cwd: projectDir,
            exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
          });
          requireCliSuccess(before, "status setup");

          const stop = yield* runSupabaseEffect(["stop"], {
            cwd: projectDir,
            exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
          });
          expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
          expect(stop.stdout).toContain("Stopped");

          expect(yield* remainingContainerIds(projectId)).toBe("");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    STOP_TEST_TIMEOUT_MS,
  );

  it.live(
    "stop --no-backup --debug reports real pruned containers, volumes, and network",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const projectDir = project.dir;
          // Sanitizing is currently a no-op for a `mkdtemp` basename (already alphanumeric/`-`),
          // but this mirrors the CLI's actual project-id resolution instead of assuming that
          // stays true.
          const projectId = sanitizeProjectId(path.basename(projectDir));

          const init = yield* runSupabaseEffect(["init"], {
            cwd: projectDir,
            exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
          });
          requireCliSuccess(init, "init setup");
          yield* overrideStackPortsIn(projectDir);

          const start = yield* runSupabaseEffect(
            ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
            { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
          );
          requireCliSuccess(start, "start setup");

          // `--no-backup` exercises the volume-prune branch; `--debug` turns on the `Pruned …:`
          // stderr reports, which parse real `docker`/`podman` prune stdout — the format
          // assumption (`Deleted …:` headers, `Total reclaimed space:` trailer) that mocked
          // fixtures can't validate.
          const stop = yield* runSupabaseEffect(["stop", "--no-backup", "--debug"], {
            cwd: projectDir,
            exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
          });
          expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
          expect(stop.stdout).toContain("Stopped");

          expect(stop.stderr).toMatch(/^Pruned containers: \[[0-9a-f][^\]]*\]$/mu);
          // The db volume always exists (never excluded), so the report must name it.
          const volumesLine = stop.stderr
            .split("\n")
            .find((line) => line.startsWith("Pruned volumes: ["));
          expect(volumesLine, `stderr:\n${stop.stderr}`).toContain(`supabase_db_${projectId}`);
          // The prune report's network label is singular ("network"), unlike containers/volumes.
          expect(stop.stderr).toContain(`Pruned network: [supabase_network_${projectId}]`);

          expect(yield* remainingContainerIds(projectId)).toBe("");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    STOP_TEST_TIMEOUT_MS,
  );
});
