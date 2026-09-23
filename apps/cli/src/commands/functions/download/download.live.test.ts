import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";

import {
  type LiveFixtures,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];

class FunctionsDownloadLiveError extends Data.TaggedError("FunctionsDownloadLiveError")<{
  readonly message: string;
}> {}

function cleanupFunction(cliEffect: LiveCliEffect, slug: string, ref: string) {
  return Effect.gen(function* () {
    const deleted = yield* cliEffect(["functions", "delete", slug, "--project-ref", ref]);
    if (
      deleted.exitCode !== 0 &&
      !/not found|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`)
    ) {
      return yield* new FunctionsDownloadLiveError({
        message: `functions delete cleanup failed:\n${deleted.stdout}\n${deleted.stderr}`,
      });
    }
  });
}

describe("functions download (live)", () => {
  test("round-trips a deployed function's source through the live project", ({
    cliEffect,
    project,
    workspace,
  }) => {
    const slug = `cli-e2e-download-${randomUUID().slice(0, 8)}`;
    const marker = randomUUID();
    const source = `Deno.serve(() => Response.json({ marker: ${JSON.stringify(marker)}, ok: true }));\n`;
    return Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = path.join(workspace.path, "supabase", "functions", slug);
        const entrypoint = path.join(directory, "index.ts");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(entrypoint, source);
        yield* fs.writeFileString(path.join(directory, "deno.json"), '{\n  "imports": {}\n}\n');

        const target = Effect.gen(function* () {
          const deployed = yield* cliEffect(["functions", "deploy", "--project-ref", project.ref]);
          requireLiveSuccess(deployed, "functions deploy setup");

          yield* fs.remove(directory, { recursive: true, force: true });
          expect(
            yield* fs.exists(entrypoint),
            "local function source should be gone before download",
          ).toBe(false);

          // The unbundle container writes as root; pre-create the directory
          // host-owned and world-writable (mirroring the deploy bundler's own
          // pre-created output dir) so the CI runner can remove it afterward.
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.chmod(directory, 0o777);

          const downloaded = yield* cliEffect([
            "functions",
            "download",
            slug,
            "--project-ref",
            project.ref,
          ]);
          const downloadOutput = `stdout:\n${downloaded.stdout}\nstderr:\n${downloaded.stderr}`;
          expect(downloaded.exitCode, downloadOutput).toBe(0);
          // Lowercase "function:" pins the docker unbundle path specifically,
          // distinct from the server-fallback's "Downloading Function:".
          expect(downloaded.stderr, downloadOutput).toContain("Downloading function:");
          expect(yield* fs.exists(entrypoint), downloadOutput).toBe(true);
          const roundTripped = yield* fs.readFileString(entrypoint);
          expect(roundTripped, downloadOutput).toContain(marker);
        });

        const targetExit = yield* Effect.exit(target);
        const cleanupExit = yield* Effect.exit(cleanupFunction(cliEffect, slug, project.ref));
        return {
          targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
          cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
        };
      }).pipe(Effect.provide(BunServices.layer)),
    ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors));
  });
});
