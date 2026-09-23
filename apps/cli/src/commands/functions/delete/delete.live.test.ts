import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import { type LiveFixtures, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];

class FunctionsDeleteLiveError extends Data.TaggedError("FunctionsDeleteLiveError")<{
  readonly message: string;
}> {}

function cleanupFunction(cliEffect: LiveCliEffect, slug: string, ref: string) {
  return Effect.gen(function* () {
    const deleted = yield* cliEffect(["functions", "delete", slug, "--project-ref", ref]);
    if (
      deleted.exitCode !== 0 &&
      !/not found|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`)
    ) {
      return yield* new FunctionsDeleteLiveError({
        message: `functions delete cleanup failed:\n${deleted.stdout}\n${deleted.stderr}`,
      });
    }
  });
}

test("deletes a deployed function", ({ cliEffect, project, workspace }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const slug = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
      const directory = path.join(workspace.path, "supabase", "functions", slug);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "index.ts"),
        "Deno.serve(() => Response.json({ ok: true }));\n",
      );
      yield* fs.writeFileString(path.join(directory, "deno.json"), '{\n  "imports": {}\n}\n');

      const target = Effect.gen(function* () {
        const deployed = yield* cliEffect([
          "functions",
          "deploy",
          slug,
          "--project-ref",
          project.ref,
          "--use-api",
        ]);
        if (deployed.exitCode !== 0) {
          return yield* new FunctionsDeleteLiveError({
            message: `functions deploy setup failed (exit ${deployed.exitCode})\nstdout:\n${deployed.stdout}\nstderr:\n${deployed.stderr}`,
          });
        }

        const result = yield* cliEffect([
          "functions",
          "delete",
          slug,
          "--project-ref",
          project.ref,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("Deleted Function");
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(cleanupFunction(cliEffect, slug, project.ref));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }).pipe(Effect.provide(BunServices.layer)),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
