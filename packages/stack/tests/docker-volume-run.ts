import { randomUUID } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { runDocker } from "./docker-fixture.ts";

/**
 * Environment variable `DockerDatabaseStorage` reads to label volumes a test run creates.
 *
 * Docker test state roots must be private to a run (see `makeDockerDatabaseRoot` and
 * `Commands.integration.test.ts`'s Docker variants): a shared root's volume would be labelled
 * by whichever run first creates it, and a later run sharing that root could have its data
 * removed by this cleanup. The `@supabase/stack/testing` default shared root is outside this
 * cleanup and must not be used for Docker-backed tests.
 */
export const stackTestRunEnvVar = "SUPABASE_STACK_TEST_RUN";

const managedFilter = "label=com.supabase.stack-managed=true";
const testRunFilter = (id: string) => `label=com.supabase.stack-test-run=${id}`;

/**
 * Removes exactly the stack-managed Docker volumes labelled with this test run's id. Prints one
 * note and does nothing when Docker is missing or its daemon is unreachable.
 */
export const removeTestRunVolumes = Effect.fn("DockerVolumeRun.removeTestRunVolumes")(
  (id: string) =>
    Effect.gen(function* () {
      const probe = yield* runDocker(["info", "--format", "{{.ID}}"]).pipe(
        Effect.catchCause(() => Effect.succeed({ output: "docker is unavailable", code: 1 })),
      );
      if (probe.code !== 0) {
        yield* Effect.logWarning(
          "[docker-volume-run] Skipping test-run Docker volume cleanup: Docker is missing or its daemon is unreachable.",
        );
        return;
      }
      const listed = yield* runDocker([
        "volume",
        "ls",
        "-q",
        "--filter",
        managedFilter,
        "--filter",
        testRunFilter(id),
      ]);
      if (listed.code !== 0)
        return yield* Effect.die(`docker volume ls failed: ${listed.output.trim()}`);
      const volumes = listed.output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (volumes.length === 0) return;
      const removals = yield* Effect.forEach(volumes, (volume) =>
        runDocker(["volume", "rm", volume]).pipe(Effect.map((result) => ({ volume, result }))),
      );
      const failed = removals.filter(({ result }) => result.code !== 0);
      if (failed.length > 0)
        return yield* Effect.die(
          `Failed to remove test-run Docker volumes: ${failed
            .map(({ volume, result }) => `${volume} (${result.output.trim()})`)
            .join(", ")}`,
        );
    }),
);

/**
 * Vitest `globalSetup`, wired into the integration and e2e projects of both `packages/stack` and
 * `apps/cli`. Generates one random id for this invocation and removes the Docker volumes it
 * labels when the run ends, unless an outer invocation already owns `SUPABASE_STACK_TEST_RUN`:
 * the root `vitest.config.ts` aggregates every package's projects, so several project setups can
 * run in one invocation, and only the outermost one should own cleanup.
 */
// oxlint-disable-next-line effecttsgo/async-function -- Vitest's globalSetup API requires a Promise-returning function; this is the non-Effect consumer boundary.
export async function setup(): Promise<(() => Promise<void>) | undefined> {
  // oxlint-disable-next-line effecttsgo/process-env -- must be a real process.env value so vitest workers and spawned CLI subprocesses inherit it.
  if (process.env[stackTestRunEnvVar] !== undefined) return undefined;
  const id = randomUUID();
  // oxlint-disable-next-line effecttsgo/process-env -- see above.
  process.env[stackTestRunEnvVar] = id;
  // oxlint-disable-next-line effecttsgo/async-function -- the returned teardown is Vitest's globalSetup contract, not application logic.
  return async () => {
    await Effect.runPromise(removeTestRunVolumes(id).pipe(Effect.provide(NodeServices.layer)));
  };
}

export default setup;
