import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { legacyIsLocalDbRunning } from "./db-bootstrap/local-db-running.ts";
import { legacyContainerCliExitCodeAndStdout } from "./legacy-container-cli.ts";

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

/**
 * A spawner that runs `/bin/sh -c <script>` (with the call site's own stdio
 * options) no matter which container CLI the caller asked for. This recreates
 * supabase/cli#6110's Windows deadlock with REAL OS pipes, deterministically,
 * on any POSIX host: pipe-EOF semantics are identical across platforms — EOF
 * only arrives once every holder of the write end closes it — so a `sleep`
 * grandchild inheriting the pipe stands in exactly for the Docker Desktop
 * helper process that inherits `docker.exe`'s stdio handles on Windows and
 * outlives it. Only the trigger is platform-specific, not the deadlock.
 */
function shScriptSpawner(real: Spawner, script: string): Spawner {
  return ChildProcessSpawner.make((command) =>
    command._tag === "StandardCommand"
      ? real.spawn(ChildProcess.make("/bin/sh", ["-c", script], command.options))
      : real.spawn(command),
  );
}

const withRealServices = <A, E>(
  body: (services: {
    readonly spawner: Spawner;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* body({ spawner, fs, path });
  }).pipe(Effect.provide(BunServices.layer));

// `/bin/sh` scripts — skipped on Windows, where the mechanism under test is
// instead exercised for real by the docker.exe helper-process behavior this
// suite simulates (see `shScriptSpawner`).
describe.skipIf(process.platform === "win32")(
  "container-CLI stdio is bounded by child exit",
  () => {
    const workdir = useLegacyTempWorkdir();

    // The supabase/cli#6110 repro: `db start`'s very first Docker touch is
    // `legacyIsLocalDbRunning`'s `container inspect`, whose stderr drain used
    // to run to pipe EOF before the exit code was consulted. A lingering
    // grandchild holding the inherited stderr write end blocked that drain for
    // its whole lifetime (or forever, for a persistent helper) even though the
    // child had long exited with a classifiable "No such container" — the
    // silent hang in the issue. The child exits immediately; the `sleep 15`
    // outlives `legacyGateOnExitCode`'s post-exit idle window by two orders of
    // magnitude, so a regression back to EOF-gated reads re-blocks the drain
    // and trips this test's timeout instead of passing slowly.
    it.live(
      "db start's already-running probe resolves while a grandchild still holds stderr",
      () =>
        withRealServices(({ spawner, fs, path }) =>
          Effect.gen(function* () {
            const script =
              "echo 'Error response from daemon: No such container: x' 1>&2; sleep 15 & exit 1";
            const running = yield* legacyIsLocalDbRunning(
              shScriptSpawner(spawner, script),
              fs,
              path,
              workdir.current,
              undefined,
            );
            // Completing at all is the fix; classifying the pre-exit stderr as
            // "not running" (rather than an inspect failure) proves the grace
            // window still delivered the child's full stderr.
            expect(running).toBe(false);
          }),
        ),
      10_000,
    );

    // Same deadlock, other consumption pattern: the concurrent
    // `Effect.all([exitCode, drain stdout])` helpers only complete once BOTH
    // effects do, so a held stdout pipe used to hang them just like the
    // sequential probe above.
    it.live(
      "the concurrent exit+stdout helper completes while a grandchild still holds stdout",
      () =>
        withRealServices(({ spawner }) =>
          Effect.gen(function* () {
            const script = "echo hello; sleep 15 & exit 0";
            const result = yield* legacyContainerCliExitCodeAndStdout(
              shScriptSpawner(spawner, script),
              ["ps"],
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe("hello\n");
          }),
        ),
      10_000,
    );

    // Guards the fix's other half: a well-behaved child (no lingering handle
    // holder) must complete via its drains' natural EOF at exit, not sit out
    // even one post-exit idle slice — otherwise every docker call in a
    // bring-up would slow down. The bound is far above a normal sub-100ms run
    // but tight enough to catch an unconditional post-exit wait creeping in.
    it.live(
      "a clean child completes without waiting out the post-exit idle window",
      () =>
        withRealServices(({ spawner, fs, path }) =>
          Effect.gen(function* () {
            const script = "echo 'Error response from daemon: No such container: x' 1>&2; exit 1";
            const startedAt = Date.now();
            const running = yield* legacyIsLocalDbRunning(
              shScriptSpawner(spawner, script),
              fs,
              path,
              workdir.current,
              undefined,
            );
            expect(running).toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(1_500);
          }),
        ),
      10_000,
    );
  },
);
